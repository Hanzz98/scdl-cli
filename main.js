const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const axios = require('axios');
const { execSync } = require('child_process');
const { prepareDownload } = require('./download');

const DEFAULT_THREAD_COUNT = 3;

class Arguments {
    constructor() {
        this.tempDir = os.tmpdir();
        this.downloadDir = process.cwd();
        this.originalCoverImage = false;
        this.disableCache = false;
        this.threadCount = DEFAULT_THREAD_COUNT;
    }
}

function checkFFmpeg() {
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

async function getClientId() {
    try {
        console.log('Fetching SoundCloud client ID...');
        const response = await axios.get('https://soundcloud.com/zeunig/test');
        const html = response.data;

        const scriptRegex = /https:\/\/a-v2\.sndcdn\.com\/assets\/([0-9]{1,3}-[a-zA-Z0-9*?]{8})\.js/g;
        const scripts = [...html.matchAll(scriptRegex)].map(m => m[0]);

        for (const scriptUrl of scripts) {
            try {
                const scriptResponse = await axios.get(scriptUrl);
                const scriptContent = scriptResponse.data;

                const clientIdMatch = scriptContent.match(/client_id:"([^"]+)"/);
                if (clientIdMatch && clientIdMatch[1]) {
                    console.log('Client ID found!');
                    return clientIdMatch[1];
                }
            } catch (error) {
                continue;
            }
        }

        throw new Error('No client ID found');
    } catch (error) {
        console.error('Failed to get client ID:', error.message);
        process.exit(1);
    }
}

function parseArguments(args) {
    const arguments = new Arguments();

    // Parse --temp-dir
    const tempDirArg = args.find(arg => arg.startsWith('--temp-dir='));
    if (tempDirArg) {
        const tempDir = tempDirArg.split('=')[1];
        if (fsSync.existsSync(tempDir) && fsSync.statSync(tempDir).isDirectory()) {
            arguments.tempDir = tempDir;
        } else {
            console.log('Invalid temp_dir, using default option');
        }
    }

    // Parse --download-dir
    const downloadDirArg = args.find(arg => arg.startsWith('--download-dir='));
    if (downloadDirArg) {
        const downloadDir = downloadDirArg.split('=')[1];
        if (fsSync.existsSync(downloadDir) && fsSync.statSync(downloadDir).isDirectory()) {
            arguments.downloadDir = downloadDir;
        } else {
            console.log('Invalid download_dir, using default option');
        }
    }

    // Parse --original-cover-size
    if (args.includes('--original-cover-size')) {
        arguments.originalCoverImage = true;
    }

    // Parse --disable-cache
    if (args.includes('--disable-cache')) {
        arguments.disableCache = true;
    }

    // Parse --thread-count
    const threadCountArg = args.find(arg => arg.startsWith('--thread-count='));
    if (threadCountArg) {
        const threadCount = parseInt(threadCountArg.split('=')[1]);
        if (!isNaN(threadCount) && threadCount > 0) {
            arguments.threadCount = threadCount;
        }
    }

    return arguments;
}

function showHelp() {
    console.log(`SCDownload - Made by Hann Universe

This software allows you to easily download tracks, albums and playlists from SoundCloud into your computer/handphone.

Usage:
  node main.js <track/album/playlist/artist/liked> <id of the track/album/playlist>

Additional arguments:
  --temp-dir="path"          - Sets the temporary folder location
  --download-dir="path"      - Sets the download folder location
  --thread-count=10          - Sets the amount of threads (only valid for downloading playlist)
  --original-cover-size      - Downloads the song cover in its original size
  --disable-cache            - Forces the program to redownload all the songs

Examples:
  node main.js track odcodone/lp-printer
  node main.js album ossianofficial/sets/best-of-1998-2008
  node main.js playlist zeunig/sets/hardstyle
  node main.js artist zeunig
  node main.js liked zeunig`);
}

function validateArguments(args) {
    if (args.length < 3) {
        showHelp();
        process.exit(0);
    }

    const type = args[2];
    const validTypes = ['track', 'album', 'playlist', 'artist', 'liked'];

    if (!validTypes.includes(type)) {
        console.log(`Invalid usage, expected valid type: ${validTypes.join('/')}`);
        showHelp();
        process.exit(0);
    }

    if (args.length < 4) {
        const examples = {
            'track': 'odcodone/lp-printer',
            'album': 'ossianofficial/sets/best-of-1998-2008',
            'playlist': 'zeunig/sets/hardstyle',
            'artist': 'zeunig',
            'liked': 'zeunig'
        };

        console.log(`\nInvalid usage, expected ${type} ID:`);
        console.log(`example: ${examples[type]}`);
        process.exit(0);
    }
}

function trimming(track) {
    let result = track;

    if (result.includes('https://soundcloud.com/')) {
        result = result.split('https://soundcloud.com/')[1];
    }

    if (result.includes('?')) {
        result = result.split('?')[0];
    }

    return result;
}

async function playlistToVec(trackIds, clientId) {
    const headers = {
        'Accept': 'application/json, text/javascript, */*; q=0.1',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://soundcloud.com',
        'Referer': 'https://soundcloud.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    const result = [];
    const batchSize = 10;

    for (let i = 0; i < trackIds.length; i += batchSize) {
        const batch = trackIds.slice(i, i + batchSize);
        const idsParam = batch.join('%2C');
        const url = `https://api-v2.soundcloud.com/tracks?ids=${idsParam}&client_id=${clientId}&app_version=1694501791&app_locale=en`;

        try {
            const response = await axios.get(url, { headers });
            const data = JSON.stringify(response.data);

            const regex = /"permalink_url":"https:\/\/soundcloud\.com\/((?:[^"/]*?)\/(?:[^"/]*?))"/g;
            const matches = [...data.matchAll(regex)];

            matches.forEach(match => {
                if (match[1]) {
                    result.push(match[1]);
                }
            });
        } catch (error) {
            console.error(`Error fetching batch: ${error.message}`);
        }
    }

    return result;
}

async function playlistToVec(trackIds, clientId) {
    const axios = require('axios');
    const headers = {
        'Accept': 'application/json, text/javascript, */*; q=0.1',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://soundcloud.com',
        'Referer': 'https://soundcloud.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    
    const result = [];
    const batchSize = 10;
    
    for (let i = 0; i < trackIds.length; i += batchSize) {
        const batch = trackIds.slice(i, i + batchSize);
        const idsParam = batch.join('%2C');
        const url = `https://api-v2.soundcloud.com/tracks?ids=${idsParam}&client_id=${clientId}&app_version=1694501791&app_locale=en`;
        
        try {
            const response = await axios.get(url, { headers });
            const data = JSON.stringify(response.data);
            
            const regex = /"permalink_url":"https:\/\/soundcloud\.com\/((?:[^"/]*?)\/(?:[^"/]*?))"/g;
            const matches = [...data.matchAll(regex)];
            
            matches.forEach(match => {
                if (match[1]) {
                    result.push(match[1]);
                }
            });
        } catch (error) {
            console.error(`Error fetching batch: ${error.message}`);
        }
    }
    
    return result;
}


async function main() {
    if (!checkFFmpeg()) {
        console.log('WARNING: FFmpeg is not installed!');
        console.log('Please install FFmpeg to use this application.');
        console.log('Visit: https://ffmpeg.org/download.html');
        process.exit(1);
    }

    const args = process.argv;

    validateArguments(args);

    const arguments = parseArguments(args);
    arguments.tempDir = path.join(arguments.tempDir, 'SCDownloader');

    const clientId = await getClientId();

    console.log(`Config:
- Disable cache: ${arguments.disableCache}
- Temp directory: ${arguments.tempDir}
- Download directory: ${arguments.downloadDir}
- Threads: ${arguments.threadCount}
- Keep original cover size: ${arguments.originalCoverImage}`);

    const type = args[2];
    let arg2 = args[3];

    try {
        switch (type) {
            case 'track': {
                arg2 = trimming(arg2);
                await prepareDownload([arg2], arguments, true, clientId);
                break;
            }

            case 'playlist':
            case 'album': {
                console.log('Fetching playlist...');
                arg2 = trimming(arg2);

                arguments.downloadDir = path.join(arguments.downloadDir, arg2);

                const headers = {
                    'Accept': 'application/json, text/javascript, */*; q=0.1',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                };

                const response = await axios.get(`https://soundcloud.com/${arg2}`, { headers });
                const html = response.data;

                const trackIdRegex = /"id":([0-9]+?),"kind":"track"/g;
                const trackIds = [...html.matchAll(trackIdRegex)].map(m => m[1]);

                const songs = await playlistToVec(trackIds, clientId);
                await prepareDownload(songs, arguments, false, clientId);
                break;
            }

            case 'artist': {
                console.log('Disclaimer: This feature is made for artists to back up their songs.');
                console.log('If you\'re downloading another artist\'s songs, please ask for permission first.');
                console.log('Press Ctrl+C to cancel or wait 3 seconds to continue...\n');

                await new Promise(resolve => setTimeout(resolve, 3000));

                console.log('Fetching artist songs...');
                arg2 = trimming(arg2);

                arguments.downloadDir = path.join(arguments.downloadDir, 'artist', arg2);

                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                };

                const response = await axios.get(`https://soundcloud.com/${arg2}`, { headers });
                const html = response.data;

                const uidMatch = html.match(/content="soundcloud:\/\/users:([0-9]+?)"/);
                if (!uidMatch) {
                    throw new Error('User ID not found');
                }

                const uid = uidMatch[1];
                const tracksUrl = `https://api-v2.soundcloud.com/users/${uid}/tracks?offset=0&limit=79999&client_id=${clientId}&app_version=1694761046&app_locale=en`;

                const tracksResponse = await axios.get(tracksUrl, { headers });
                const tracksData = JSON.stringify(tracksResponse.data);

                const permalinkRegex = /"permalink_url":"https:\/\/soundcloud\.com\/((?:[a-zA-Z0-9-_]*?)\/(?:[a-zA-Z0-9-_]*?))"/g;
                const songs = [...tracksData.matchAll(permalinkRegex)].map(m => m[1]);

                await new Promise(resolve => setTimeout(resolve, 5000));
                await prepareDownload(songs, arguments, false, clientId);
                break;
            }

            case 'liked': {
                console.log('Fetching liked songs...');

                if (arg2.includes('/likes')) {
                    arg2 = arg2.split('/likes')[0];
                }
                arg2 = trimming(arg2);

                arguments.downloadDir = path.join(arguments.downloadDir, 'liked', arg2);

                const headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                };

                const response = await axios.get(`https://soundcloud.com/${arg2}`, { headers });
                const html = response.data;

                const uidMatch = html.match(/soundcloud:\/\/users:([0-9]+?)"/);
                if (!uidMatch) {
                    throw new Error('User ID not found');
                }

                const uid = uidMatch[1];
                const likesUrl = `https://api-v2.soundcloud.com/users/${uid}/likes?client_id=${clientId}&limit=999999&offset=0&linked_partitioning=1&app_version=1709298204&app_locale=en`;

                const likesResponse = await axios.get(likesUrl, { headers });
                const likesData = JSON.stringify(likesResponse.data);

                const permalinkRegex = /"permalink_url":"https:\/\/soundcloud\.com\/((?:[a-zA-Z0-9-_]*?)\/(?:[a-zA-Z0-9-_]*?))"/g;
                const allMatches = [...likesData.matchAll(permalinkRegex)];
                const songs = allMatches
                    .map(m => m[1])
                    .filter(uri => !uri.includes('/sets/')); 
                await new Promise(resolve => setTimeout(resolve, 1000));
                await prepareDownload(songs, arguments, false, clientId);
                break;
            }
        }

    } catch (error) {
        console.error(`\nError: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { main, getClientId, parseArguments, playlistToVec };
