const fs = require('fs');
const { google } = require('googleapis');
const { execSync } = require('child_process');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY || "Ec7ERcQMMh2AZu3J";
const IA_SECRET_KEY = process.env.IA_SECRET_KEY || "OJNNSv2stNxtKTNn";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "https://hook.eu1.make.com/vxx5wns1pe9s6h4cziei7j3ojhfh8m23";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
    if (!fs.existsSync('temp/meta.json')) {
        console.log("No meta.json found in temp folder.");
        return;
    }

    const meta = JSON.parse(fs.readFileSync('temp/meta.json', 'utf8'));
    const podcastId = meta.podcastId || "zarebin";
    const title = meta.title || "Podcast Episode";
    const description = meta.description || "";
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const categoryName = meta.categoryName ? meta.categoryName.trim() : "";
    const publishAt = meta.publishAt || null;
    const platforms = meta.platforms || { youtube: true, spotify: true, instagram: false, tiktok: false };
    const done = meta.done || { youtube: false, spotify: false, instagram: false, tiktok: false };
    const epId = meta.timestamp || Date.now();
    const bucketName = `zarrebin-podcast-${epId}`;
    const encodedTitle = encodeURIComponent(title);

    const now = new Date();
    const isFuture = publishAt && (new Date(publishAt) > now);

    if (platforms.youtube && !done.youtube && fs.existsSync('temp/horizontal.jpg') && fs.existsSync('temp/audio.mp3')) {
        console.log("Generating 16:9 video for YouTube...");
        const ytCmd = 'ffmpeg -y -loop 1 -i temp/horizontal.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -shortest youtube.mp4';
        execSync(ytCmd, { stdio: 'inherit' });

        const oauth2Client = new google.auth.OAuth2(
            process.env.YT_CLIENT_ID,
            process.env.YT_CLIENT_SECRET,
            "https://developers.google.com/oauthplayground"
        );

        oauth2Client.setCredentials({
            refresh_token: process.env.YT_REFRESH_TOKEN
        });

        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        const statusObj = isFuture
            ? { privacyStatus: 'private', publishAt: publishAt }
            : { privacyStatus: 'public' };

        console.log("Uploading to YouTube...");
        const res = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: title,
                    description: description,
                    tags: tags,
                    categoryId: '22'
                },
                status: statusObj
            },
            media: {
                body: fs.createReadStream('youtube.mp4')
            }
        });

        const videoId = res.data.id;
        console.log(`YouTube upload complete. ID: ${videoId}`);

        if (categoryName) {
            await handleYouTubePlaylist(youtube, videoId, categoryName);
        }

        done.youtube = true;
    }

    if (isFuture) {
        console.log(`Scheduled time (${publishAt}) has not arrived yet for other platforms. Keeping files in temp.`);
        meta.done = done;
        fs.writeFileSync('temp/meta.json', JSON.stringify(meta, null, 2));
        return;
    }

    if ((platforms.instagram || platforms.tiktok) && (!done.instagram || !done.tiktok) && fs.existsSync('temp/vertical.jpg') && fs.existsSync('temp/audio.mp3')) {
        console.log("Generating 9:16 vertical video compatible with Instagram Reels & TikTok...");
        const vertCmd = 'ffmpeg -y -loop 1 -framerate 30 -i temp/vertical.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -preset veryfast -crf 28 -r 30 -g 60 -c:a aac -b:a 128k -ar 44100 -ac 2 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -movflags +faststart -shortest vertical.mp4';
        execSync(vertCmd, { stdio: 'inherit' });

        console.log("Uploading vertical video to Catbox for direct non-redirect URL...");
        try {
            const uploadCmd = `curl -s --fail -F "reqtype=fileupload" -F "fileToUpload=@vertical.mp4" https://catbox.moe/user/api.php`;
            let directVideoUrl = execSync(uploadCmd).toString().trim();

            if (!directVideoUrl.startsWith('https://files.catbox.moe/')) {
                console.log("Catbox primary failed, using Litterbox fallback...");
                const fallbackCmd = `curl -s --fail -F "reqtype=fileupload" -F "time=72h" -F "fileToUpload=@vertical.mp4" https://litterbox.catbox.moe/resources/internals/api.php`;
                directVideoUrl = execSync(fallbackCmd).toString().trim();
            }

            console.log(`Direct video URL ready: ${directVideoUrl}`);
            await sleep(3000);

            const hashtags = tags.length > 0 ? '\n\n' + tags.map(t => t.startsWith('#') ? t : `#${t.replace(/\s+/g, '_')}`).join(' ') : '';
            const fullCaption = `${title}\n\n${description}${hashtags}`;

            console.log("Sending video data to Make.com webhook...");
            await axios.post(MAKE_WEBHOOK_URL, {
                podcast_id: podcastId,
                title: title,
                caption: fullCaption,
                video_url: directVideoUrl,
                instagram: Boolean(platforms.instagram && !done.instagram),
                tiktok: Boolean(platforms.tiktok && !done.tiktok)
            });

            if (platforms.instagram) done.instagram = true;
            if (platforms.tiktok) done.tiktok = true;
            console.log("Make.com webhook triggered successfully.");
        } catch (err) {
            console.error("Error in Make.com / Video publishing:", err.response?.data || err.message);
        }
    }

    if (platforms.spotify && !done.spotify && fs.existsSync('temp/audio.mp3')) {
        console.log("Uploading episode audio and cover to Archive.org...");
        const fileSize = fs.statSync('temp/audio.mp3').size;

        const uploadAudioCmd = `curl --location --fail --upload-file temp/audio.mp3 -H "authorization: LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}" -H "x-archive-auto-make-bucket:1" -H "x-archive-meta-mediatype:audio" -H "x-archive-meta-collection:opensource_audio" -H "x-archive-meta-title:uri(${encodedTitle})" -H "x-archive-meta-creator:ZarrebinPodcast" "https://s3.us.archive.org/${bucketName}/ep_${epId}.mp3"`;
        execSync(uploadAudioCmd, { stdio: 'inherit' });
        const audioUrl = `https://archive.org/download/${bucketName}/ep_${epId}.mp3`;

        let coverUrl = "https://amirzadehes.github.io/podcast-publisher/cover.jpg";
        if (fs.existsSync('temp/square.jpg')) {
            const scaleCoverCmd = `ffmpeg -y -i temp/square.jpg -vf "scale=1400:1400:force_original_aspect_ratio=increase,crop=1400:1400" temp/cover_1400.jpg`;
            execSync(scaleCoverCmd, { stdio: 'inherit' });

            const uploadCoverCmd = `curl --location --fail --upload-file temp/cover_1400.jpg -H "authorization: LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}" "https://s3.us.archive.org/${bucketName}/cover_${epId}.jpg"`;
            execSync(uploadCoverCmd, { stdio: 'inherit' });
            coverUrl = `https://archive.org/download/${bucketName}/cover_${epId}.jpg`;
        }

        const pubDate = publishAt ? new Date(publishAt).toUTCString() : new Date().toUTCString();

        let feed = '';
        if (fs.existsSync('feed.xml') && fs.readFileSync('feed.xml', 'utf8').includes('<channel>')) {
            feed = fs.readFileSync('feed.xml', 'utf8');
        } else {
            feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>ذره‌بین</title>
    <link>https://amirzadehes.github.io/podcast-publisher/</link>
    <description>پادکست ذره‌بین</description>
    <language>fa</language>
    <itunes:author>Amir Ahmad Hosseinzadeh</itunes:author>
    <itunes:owner>
      <itunes:name>ذره‌بین</itunes:name>
      <itunes:email>zadeh.amah@gmail.com</itunes:email>
    </itunes:owner>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <itunes:category text="Society &amp; Culture"/>
    <itunes:image href="${coverUrl}"/>
  </channel>
</rss>`;
        }

        const categoryTag = categoryName ? `\n      <category><![CDATA[${categoryName}]]></category>` : '';

        const newItem = `    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[${description}]]></description>${categoryTag}
      <enclosure url="${audioUrl}" length="${fileSize}" type="audio/mpeg" />
      <guid isPermaLink="false">ep_${epId}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:explicit>false</itunes:explicit>
      <itunes:image href="${coverUrl}" />
    </item>`;

        if (feed.includes('<item>')) {
            feed = feed.replace('<item>', `${newItem}\n    <item>`);
        } else {
            feed = feed.replace('</channel>', `${newItem}\n  </channel>`);
        }

        fs.writeFileSync('feed.xml', feed);
        console.log("Spotify RSS feed updated with Archive.org links.");
        done.spotify = true;
    }

    fs.writeFileSync('temp/completed.flag', 'done');
}

async function handleYouTubePlaylist(youtube, videoId, playlistTitle) {
    try {
        let playlistId = null;
        let nextPageToken = null;

        do {
            const plRes = await youtube.playlists.list({
                part: 'snippet',
                mine: true,
                maxResults: 50,
                pageToken: nextPageToken
            });

            if (plRes.data.items) {
                const found = plRes.data.items.find(item => item.snippet.title.trim().toLowerCase() === playlistTitle.trim().toLowerCase());
                if (found) {
                    playlistId = found.id;
                    console.log(`Found existing playlist "${playlistTitle}" with ID: ${playlistId}`);
                    break;
                }
            }
            nextPageToken = plRes.data.nextPageToken;
        } while (nextPageToken);

        if (!playlistId) {
            console.log(`Playlist "${playlistTitle}" not found. Creating new playlist...`);
            const createRes = await youtube.playlists.insert({
                part: 'snippet,status',
                requestBody: {
                    snippet: {
                        title: playlistTitle,
                        description: `پلی‌لیست ${playlistTitle}`
                    },
                    status: {
                        privacyStatus: 'public'
                    }
                }
            });
            playlistId = createRes.data.id;
            console.log(`Created new playlist with ID: ${playlistId}. Waiting 5 seconds for YouTube indexing...`);
            await sleep(5000);
        } else {
            await sleep(2000);
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await youtube.playlistItems.insert({
                    part: 'snippet',
                    requestBody: {
                        snippet: {
                            playlistId: playlistId,
                            resourceId: {
                                kind: 'youtube#video',
                                videoId: videoId
                            }
                        }
                    }
                });
                console.log(`Successfully added video ${videoId} to playlist "${playlistTitle}".`);
                break;
            } catch (insertErr) {
                console.error(`Attempt ${attempt} to add video to playlist failed: ${insertErr.message}`);
                if (attempt < 3) {
                    console.log("Retrying in 4 seconds...");
                    await sleep(4000);
                }
            }
        }
    } catch (err) {
        console.error("Error managing YouTube playlist:", err.message);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
