const fs = require('fs');
const { google } = require('googleapis');
const { execSync } = require('child_process');

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

    if ((platforms.instagram || platforms.tiktok) && (!done.instagram || !done.tiktok) && fs.existsSync('temp/vertical.jpg') && fs.existsSync('temp/audio.mp3')) {
        console.log("Generating 9:16 vertical video for Instagram / TikTok...");
        const vertCmd = 'ffmpeg -y -loop 1 -i temp/vertical.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -t 59 -shortest vertical.mp4';
        execSync(vertCmd, { stdio: 'inherit' });
        done.instagram = true;
        done.tiktok = true;
    }

    if (platforms.spotify && !done.spotify && fs.existsSync('temp/audio.mp3')) {
        console.log("Updating Spotify RSS feed...");
        if (!fs.existsSync('episodes')) {
            fs.mkdirSync('episodes');
        }
        const audioPath = `episodes/ep_${epId}.mp3`;
        fs.copyFileSync('temp/audio.mp3', audioPath);

        let coverUrl = "https://amirzadehes.github.io/podcast-publisher/cover.jpg";
        if (fs.existsSync('temp/square.jpg')) {
            const coverPath = `episodes/cover_${epId}.jpg`;
            fs.copyFileSync('temp/square.jpg', coverPath);
            coverUrl = `https://amirzadehes.github.io/podcast-publisher/${coverPath}`;
        }

        const audioUrl = `https://amirzadehes.github.io/podcast-publisher/${audioPath}`;
        const pubDate = publishAt ? new Date(publishAt).toUTCString() : new Date().toUTCString();

        let feed = '';
        if (fs.existsSync('feed.xml')) {
            feed = fs.readFileSync('feed.xml', 'utf8');
        } else {
            feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Podcast</title>
    <link>https://amirzadehes.github.io/podcast-publisher/</link>
    <description>Podcast Feed</description>
    <language>de</language>
  </channel>
</rss>`;
        }

        const categoryTag = categoryName ? `\n      <category><![CDATA[${categoryName}]]></category>` : '';

        const newItem = `
    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[${description}]]></description>${categoryTag}
      <enclosure url="${audioUrl}" type="audio/mpeg" />
      <guid>${audioUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:image href="${coverUrl}" />
    </item>`;

        feed = feed.replace('</channel>', `${newItem}\n  </channel>`);
        fs.writeFileSync('feed.xml', feed);
        console.log("Spotify RSS feed updated.");
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

            const found = plRes.data.items.find(item => item.snippet.title.toLowerCase() === playlistTitle.toLowerCase());
            if (found) {
                playlistId = found.id;
                break;
            }
            nextPageToken = plRes.data.nextPageToken;
        } while (nextPageToken);

        if (!playlistId) {
            console.log(`Playlist "${playlistTitle}" not found. Creating new playlist...`);
            const createRes = await youtube.playlists.insert({
                part: 'snippet,status',
                requestBody: {
                    snippet: {
                        title: playlistTitle
                    },
                    status: {
                        privacyStatus: 'public'
                    }
                }
            });
            playlistId = createRes.data.id;
        }

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
        console.log(`Added video to playlist "${playlistTitle}".`);
    } catch (err) {
        console.error("Error managing YouTube playlist:", err.message);
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
