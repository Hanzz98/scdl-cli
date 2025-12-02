const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const NodeID3 = require('node-id3');

const execPromise = promisify(exec);

const MAX_CONCURRENT_DOWNLOADS = 3;
const MAX_THREAD_WAIT_MS = 50;
const METADATA_SEPARATOR = '|';
const COVER_FILENAME = 'cover.jpg';
const METADATA_FILENAME = 'metadata.txt';

const FileType = {
    UNDEFINED: 'undefined',
    MP3: 'mp3',
    M4S: 'm4s'
};

let activeDownloads = 0;

function sanitizeSongName(input) {
    if (!input) return 'Unknown';
    
    let result = input
        .replace(/\\u0026/g, 'and')
        .replace(/\\u003c3/g, 'ily')
        .replace(/[<>:"/\\|?*]/g, '');
    
    return result.trim() || 'Unknown';
}

function regexGetFirst(regex, text) {
    const match = text.match(regex);
    if (match && match[1]) {
        return match[1];
    }
    return null;
}

async function countAudioFiles(rootPath) {
    try {
        const files = await fs.readdir(rootPath);
        return files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ext === '.mp3' || ext === '.m4s';
        }).length;
    } catch (error) {
        return 0;
    }
}

function createSoundCloudHeaders() {
    return {
        'Accept': 'application/json, text/javascript, */*; q=0.1',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://soundcloud.com',
        'Pragma': 'no-cache',
        'Referer': 'https://soundcloud.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    };
}

async function downloadMetadata(songUri, arguments, tempDir) {
    const headers = createSoundCloudHeaders();

    try {
        const response = await axios.get(`https://soundcloud.com/${songUri}`, { headers });
        const html = response.data;

        const artist = regexGetFirst(/"username":"(.*?)"/, html) || 'Unknown Artist';
        const songName = regexGetFirst(/"title":"(.*?)"/, html) || 'Unknown Track';

        let cover = regexGetFirst(/<meta property="og:image" content="(.*?)"/, html) || 'None';
        if (cover !== 'None' && arguments.originalCoverImage) {
            cover = cover.replace('t500x500', 'original');
        }

        const metadataPath = path.join(tempDir, METADATA_FILENAME);
        await fs.writeFile(metadataPath, `${artist}${METADATA_SEPARATOR}${songName}${METADATA_SEPARATOR}${cover}`);

        const coverPath = path.join(tempDir, COVER_FILENAME);
        if (cover !== 'None' && !fsSync.existsSync(coverPath)) {
            const coverResponse = await axios.get(cover, { responseType: 'arraybuffer' });
            await fs.writeFile(coverPath, coverResponse.data);
        }

        return { artist, songName, cover, coverPath };
    } catch (error) {
        console.error(`Error downloading metadata: ${error.message}`);
        return { artist: 'Unknown', songName: 'Unknown', cover: 'None', coverPath: '' };
    }
}

async function downloadAudio(song, arguments, tempDir, clientId) {
    const headers = createSoundCloudHeaders();

    try {
        const response = await axios.get(`https://soundcloud.com/${song.uri}`, { headers });
        const html = response.data;

        const trackAuth = regexGetFirst(/"track_authorization":"(.*?)"/, html);
        if (!trackAuth) {
            throw new Error('Track authorization not found');
        }

        const hlsRegex = /\{"url":"(https:\/\/api-v2\.soundcloud\.com\/media\/soundcloud:tracks:[^"]+)"/g;
        const hlsMatches = [...html.matchAll(hlsRegex)];

        if (hlsMatches.length === 0) {
            throw new Error('No HLS URLs found');
        }

        for (const match of hlsMatches) {
            const hls = match[1];

            try {
                console.log(`Trying HLS link: ${hls}`);

                const streamResponse = await axios.get(
                    `${hls}?client_id=${clientId}&track_authorization=${trackAuth}`,
                    {
                        headers,
                        validateStatus: status => status < 500
                    }
                );

                if (streamResponse.status !== 200) {
                    continue;
                }

                const streamData = streamResponse.data;
                
                if (!streamData || !streamData.url) {
                    continue;
                }

                const playlistUrl = streamData.url.replace(/\\/g, '');
                console.log(`Fetching playlist...`);

                const playlistResponse = await axios.get(playlistUrl, { headers, timeout: 30000 });
                const playlist = playlistResponse.data;

                if (!playlist) continue;

                const lines = playlist.split('\n');
                const links = [];
                let initSegment = null;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    
                    if (line.startsWith('#EXT-X-MAP')) {
                        const uriMatch = line.match(/URI="([^"]+)"/);
                        if (uriMatch) {
                            const uri = uriMatch[1];
                            if (!uri.startsWith('http')) {
                                const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
                                initSegment = baseUrl + uri;
                            } else {
                                initSegment = uri;
                            }
                        }
                    }
                    
                    if (line && !line.startsWith('#') && line.includes('http')) {
                        links.push(line.replace(/["'\r]/g, ''));
                    } else if (line && !line.startsWith('#') && (line.includes('.m4s') || line.includes('.mp3'))) {
                        const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
                        links.push(baseUrl + line);
                    }
                }

                if (links.length === 0) continue;

                let fileType = FileType.MP3;
                let audioFileCount = 0;

                console.log(`Found ${links.length} segments`);
                if (initSegment) {
                    console.log('Found init segment (M4S format)');
                    fileType = FileType.M4S;
                }

                if (initSegment) {
                    try {
                        console.log('Downloading init segment...');
                        const initResponse = await axios.get(initSegment, {
                            headers,
                            responseType: 'arraybuffer',
                            timeout: 30000
                        });

                        const initPath = path.join(tempDir, 'init.mp4');
                        await fs.writeFile(initPath, initResponse.data);
                        console.log('✅ Init segment downloaded');
                    } catch (error) {
                        console.error('Warning: Failed to download init segment');
                    }
                }

                for (let i = 0; i < links.length; i++) {
                    try {
                        process.stdout.write(`\rDownloading ${i + 1}/${links.length}...`);

                        const audioResponse = await axios.get(links[i], {
                            headers,
                            responseType: 'arraybuffer',
                            timeout: 30000
                        });

                        if (!audioResponse.data) continue;

                        const isM4s = links[i].includes('.m4s') || initSegment !== null;
                        const extension = isM4s ? '.m4s' : '.mp3';
                        if (isM4s) fileType = FileType.M4S;

                        const filePath = path.join(tempDir, `${audioFileCount}${extension}`);
                        await fs.writeFile(filePath, audioResponse.data);

                        audioFileCount++;
                    } catch (error) {
                        console.error(`\nError segment ${i + 1}: ${error.message}`);
                    }
                }

                console.log('');

                if (audioFileCount === 0) continue;

                song.audioFileCount = audioFileCount;
                console.log(`✅ Downloaded ${audioFileCount} segments as ${fileType}`);
                return fileType;

            } catch (error) {
                console.error(`Error with HLS: ${error.message}`);
                continue;
            }
        }

        throw new Error('No valid download method found');

    } catch (error) {
        throw error;
    }
}

async function convertM4sToMp3(audioFileCount, tempDir, outputPath) {
    try {
        const initPath = path.join(tempDir, 'init.mp4');
        const hasInit = fsSync.existsSync(initPath);

        if (hasInit) {
            console.log('Using init segment for M4S conversion...');
            
            const buffers = [];
            
            buffers.push(await fs.readFile(initPath));
            
            for (let i = 0; i < audioFileCount; i++) {
                const segmentPath = path.join(tempDir, `${i}.m4s`);
                if (fsSync.existsSync(segmentPath)) {
                    buffers.push(await fs.readFile(segmentPath));
                }
            }

            const tempMp4 = path.join(tempDir, 'combined.mp4');
            await fs.writeFile(tempMp4, Buffer.concat(buffers));

            console.log('Converting to MP3...');
            
            await execPromise(
                `ffmpeg -i "${tempMp4}" -acodec libmp3lame -q:a 2 "${outputPath}" -y`,
                { timeout: 120000 }
            );

            await fs.unlink(tempMp4).catch(() => {});
            
        } else {
            console.log('No init segment, trying concat method...');
            
            const fileListPath = path.join(tempDir, 'filelist.txt');
            const fileListContent = [];

            for (let i = 0; i < audioFileCount; i++) {
                const segmentPath = path.join(tempDir, `${i}.m4s`);
                if (fsSync.existsSync(segmentPath)) {
                    fileListContent.push(`file '${segmentPath.replace(/'/g, "'\\''")}'`);
                }
            }

            if (fileListContent.length === 0) {
                throw new Error('No M4S segments found');
            }

            await fs.writeFile(fileListPath, fileListContent.join('\n'));

            try {
                await execPromise(
                    `ffmpeg -f concat -safe 0 -i "${fileListPath}" -acodec libmp3lame -q:a 2 "${outputPath}" -y`,
                    { timeout: 120000 }
                );
            } catch (error) {
                console.log('FFmpeg concat failed, using binary concatenation...');
                
                const buffers = [];
                for (let i = 0; i < audioFileCount; i++) {
                    const segmentPath = path.join(tempDir, `${i}.m4s`);
                    if (fsSync.existsSync(segmentPath)) {
                        buffers.push(await fs.readFile(segmentPath));
                    }
                }

                const tempMp4 = path.join(tempDir, 'combined.mp4');
                await fs.writeFile(tempMp4, Buffer.concat(buffers));

                await execPromise(
                    `ffmpeg -i "${tempMp4}" -acodec libmp3lame -q:a 2 "${outputPath}" -y`,
                    { timeout: 120000 }
                );

                await fs.unlink(tempMp4).catch(() => {});
            }

            await fs.unlink(fileListPath).catch(() => {});
        }

        console.log('✅ Conversion complete!');

    } catch (error) {
        console.error('Error converting M4S:', error.message);
        throw error;
    }
}

async function concatenateMp3Files(audioFileCount, tempDir, outputPath) {
    const inputFiles = [];
    for (let i = 0; i < audioFileCount; i++) {
        inputFiles.push(path.join(tempDir, `${i}.mp3`));
    }

    const concatString = `concat:${inputFiles.join('|')}`;
    await execPromise(`ffmpeg -i "${concatString}" -acodec copy "${outputPath}" -y`);
}

async function addMetadata(song, tempDir, downloadPath) {
    try {
        const coverPath = path.join(tempDir, COVER_FILENAME);

        const tags = {
            title: song.name,
            artist: song.artist,
            albumArtist: song.artist,
            album: song.uri,
        };

        if (fsSync.existsSync(coverPath)) {
            tags.image = {
                mime: 'image/jpeg',
                type: { id: 3, name: 'front cover' },
                description: '',
                imageBuffer: await fs.readFile(coverPath)
            };
        }

        NodeID3.write(tags, downloadPath);
        console.log(`✅ ${song.name}`);
    } catch (error) {
        console.error(`Failed to write metadata: ${error.message}`);
    }
}

async function downloadSong(songUri, arguments, isTrack, clientId) {
    const [artist, track] = songUri.split('/');
    
    const tempDir = path.join(arguments.tempDir, artist, track);
    let downloadDir = arguments.downloadDir;

    if (isTrack) {
        downloadDir = path.join(downloadDir, artist);
    }

    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(downloadDir, { recursive: true });

    const song = {
        uri: songUri,
        audioFileCount: 0,
        artist: '',
        name: '',
        cover: '',
        coverPath: ''
    };

    let fileType = FileType.UNDEFINED;

    const cachedMp3 = path.join(tempDir, '0.mp3');
    const cachedM4s = path.join(tempDir, '0.m4s');
    const metadataFile = path.join(tempDir, METADATA_FILENAME);

    if (!arguments.disableCache && (fsSync.existsSync(cachedMp3) || fsSync.existsSync(cachedM4s))) {
        console.log(`Using cache: ${songUri}`);
        song.audioFileCount = await countAudioFiles(tempDir);

        if (fsSync.existsSync(metadataFile)) {
            const metadata = (await fs.readFile(metadataFile, 'utf-8')).split(METADATA_SEPARATOR);
            song.artist = metadata[0] || 'Unknown';
            song.name = metadata[1] || 'Unknown';
        } else {
            const metadata = await downloadMetadata(songUri, arguments, tempDir);
            song.artist = metadata.artist;
            song.name = metadata.songName;
        }

        fileType = fsSync.existsSync(cachedM4s) ? FileType.M4S : FileType.MP3;
    } else {
        const metadata = await downloadMetadata(songUri, arguments, tempDir);
        song.artist = metadata.artist;
        song.name = metadata.songName;

        fileType = await downloadAudio(song, arguments, tempDir, clientId);
    }

    const sanitizedName = sanitizeSongName(song.name);
    const outputPath = path.join(downloadDir, `${sanitizedName}.mp3`);

    if (fsSync.existsSync(outputPath) && !arguments.disableCache) {
        console.log(`✅ Already exists: ${sanitizedName}.mp3`);
        return;
    }

    if (fileType === FileType.MP3) {
        console.log(`Processing MP3: ${song.name}`);
        await concatenateMp3Files(song.audioFileCount, tempDir, outputPath);
    } else if (fileType === FileType.M4S) {
        console.log(`Processing M4S: ${song.name}`);
        await convertM4sToMp3(song.audioFileCount, tempDir, outputPath);
    } else {
        console.error(`Unknown file type: ${song.name}`);
        return;
    }

    await addMetadata(song, tempDir, outputPath);
}

async function prepareDownload(songs, arguments, isTrack, clientId) {
    const maxThreads = songs.length === 1 ? 1 : arguments.threadCount || MAX_CONCURRENT_DOWNLOADS;

    const downloadQueue = [...songs];
    const downloadPromises = [];

    while (downloadQueue.length > 0 || activeDownloads > 0) {
        while (activeDownloads < maxThreads && downloadQueue.length > 0) {
            const song = downloadQueue.shift();
            activeDownloads++;

            console.log(`\n📥 Downloading: ${song}`);

            const promise = downloadSong(song, arguments, isTrack, clientId)
                .catch(error => {
                    console.error(`❌ Error: ${song} - ${error.message}`);
                })
                .finally(() => {
                    activeDownloads--;
                });

            downloadPromises.push(promise);
        }

        await new Promise(resolve => setTimeout(resolve, MAX_THREAD_WAIT_MS));
    }

    await Promise.all(downloadPromises);
    console.log('\n✅ All downloads completed!');
}

module.exports = {
    prepareDownload,
    downloadSong,
    sanitizeSongName
};
