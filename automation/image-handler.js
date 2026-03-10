'use strict';
/**
 * image-handler.js
 * Downloads article images and prepares them for batch commit to GitHub.
 *
 * Instead of hotlinking to source images, this module downloads the featured
 * image and returns it as a file pair (path + content) for inclusion in the
 * batch commit. Images are stored at public/images/articles/{slug}.{ext}.
 *
 * Falls back gracefully to the original URL on any download failure.
 */

const axios = require('axios');

const IMAGE_BASE_PATH = 'public/images/articles';

// Supported image types
const MIME_TO_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
};

/**
 * Download an image and return it as a file entry for batch commit.
 *
 * @param {string} url    - Source image URL
 * @param {string} slug   - Article slug (used for filename)
 * @returns {Promise<{localPath: string, localUrl: string, content: string}|null>}
 *   Returns null if the download fails (caller should fall back to original URL).
 *   - localPath: repo-relative path for the commit (e.g., public/images/articles/slug.jpg)
 *   - localUrl:  web-accessible path (e.g., /images/articles/slug.jpg)
 *   - content:   base64-encoded image data
 */
async function downloadImage(url, slug) {
    if (!url || !slug) return null;

    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxContentLength: 5 * 1024 * 1024, // 5 MB limit
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/webp,image/avif,image/apng,image/*,*/*;q=0.8',
            },
        });

        // Determine file extension from content-type header
        const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const ext = MIME_TO_EXT[contentType] || guessExtFromUrl(url) || 'jpg';

        // Clean slug for filename safety
        const safeSlug = slug.replace(/[^a-z0-9-]/gi, '-').slice(0, 100);
        const localPath = `${IMAGE_BASE_PATH}/${safeSlug}.${ext}`;
        const localUrl = `/images/articles/${safeSlug}.${ext}`;

        // Convert arraybuffer to base64 for git blob creation
        const content = Buffer.from(res.data).toString('base64');

        console.log(`[ImageHandler] Downloaded: ${url.slice(0, 80)}… → ${localPath} (${Math.round(res.data.byteLength / 1024)}KB)`);

        return { localPath, localUrl, content };
    } catch (err) {
        console.warn(`[ImageHandler] Failed to download image: ${err.message} — falling back to original URL`);
        return null;
    }
}

/**
 * Guess extension from a URL path when Content-Type is missing/unhelpful.
 */
function guessExtFromUrl(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        const match = pathname.match(/\.(jpe?g|png|webp|gif|avif)(?:\?|$)/);
        return match ? match[1].replace('jpeg', 'jpg') : null;
    } catch {
        return null;
    }
}

module.exports = { downloadImage };
