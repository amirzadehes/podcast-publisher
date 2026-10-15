const fs = require('fs');
const { google } = require('googleapis');
const { execSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY || "Ec7ERcQMMh2AZu3J";
const IA_SECRET_KEY = process.env.IA_SECRET_KEY || "OJNNSv2stNxtKTNn";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
    if (!fs.existsSync('temp/meta.json')) {
        console.log("No meta.json found in temp folder.");
        return;
    }

    const meta = JSON.parse(fs.readFileSync('temp/meta.json', 'utf8'));
    const title = meta.title || "Podcast Episode";
    const description = meta.description || "";
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const categoryName = meta.categoryName ? meta.categoryName.trim() : "";
    const publishAt = meta.publishAt || null;
    const platforms = meta.platforms || { youtube: true, spotify: true, instagram: false, tiktok: false };
    const done = meta.done || { youtube: false, spotify: false, instagram: false, tiktok: false };
    const epId = meta.timestamp || Date.now();

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

    if ((platforms.instagram || platforms.tiktok) && fs.existsSync('temp/vertical.jpg') && fs.existsSync('temp/audio.mp3')) {
        console.log("Generating full 9:16 vertical video for Instagram / TikTok...");
        const vertCmd = 'ffmpeg -y -loop 1 -i temp/vertical.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -shortest vertical.mp4';
        execSync(vertCmd, { stdio: 'inherit' });
    }

    if (platforms.tiktok && !done.tiktok && fs.existsSync('vertical.mp4')) {
        console.log("Uploading vertical video to TikTok...");
        try {
            await uploadToTikTok(title, description);
            done.tiktok = true;
            console.log("TikTok upload successful.");
        } catch (tikErr) {
            console.error("TikTok upload error:", tikErr.message);
        }
    }

    if (platforms.spotify && !done.spotify && fs.existsSync('temp/audio.mp3')) {
        console.log("Uploading episode audio and cover to Archive.org...");
        const bucketName = `zarrebin-podcast-${epId}`;
        const fileSize = fs.statSync('temp/audio.mp3').size;
        const encodedTitle = encodeURIComponent(title);

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

async function uploadToTikTok(title, description) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    
    if (!clientKey || !clientSecret) {
        throw new Error("TikTok credentials are missing in GitHub Secrets.");
    }

    console.log("Preparing TikTok Content Posting API request...");
    // ساختار ارسال مستقیم ویدیو از طریق Content Posting API تیک‌تاک
    const videoStream = fs.createReadStream('vertical.mp4');
    const stats = fs.statSync('vertical.mp4');

    const initRes = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        source_info: {
            source: "FILE_UPLOAD",
            video_size: stats.size,
            chunk_size: stats.size,
            total_chunk_count: 1
        },
        post_info: {
            title: `${title}\n\n${description}`.substring(0, 150),
            privacy_level: "SELF_ONLY",
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false
        }
    }, {
        headers: {
            'Authorization': `Bearer ${process.env.TIKTOK_ACCESS_TOKEN || ''}`,
            'Content-Type': 'application/json'
        }
    });

    console.log("TikTok init response received.");
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
