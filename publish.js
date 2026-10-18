const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');
const { execSync } = require('child_process');

async function uploadToArchive(itemIdentifier, localPath, remoteName, title, mediatype, collection, iaAccess, iaSecret) {
    const fileStream = fs.createReadStream(localPath);
    const fileSize = fs.statSync(localPath).size;

    await axios.put(`https://s3.us.archive.org/${itemIdentifier}/${remoteName}`, fileStream, {
        headers: {
            'Authorization': `LOW ${iaAccess}:${iaSecret}`,
            'x-archive-auto-make-bucket': '1',
            'x-archive-meta-mediatype': mediatype,
            'x-archive-meta-collection': collection,
            'x-archive-meta-title': encodeURIComponent(title),
            'x-archive-meta-creator': 'amir_hosseinzadeh843',
            'Content-Length': fileSize
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });

    return `https://archive.org/download/${itemIdentifier}/${remoteName}`;
}

async function main() {
    console.log("🚀 Starting podcast publishing pipeline...");

    if (!fs.existsSync('temp/meta.json')) {
        throw new Error("❌ temp/meta.json is missing!");
    }

    const meta = JSON.parse(fs.readFileSync('temp/meta.json', 'utf8'));
    const title = meta.title || "New Episode";
    const description = meta.description || "";
    const tags = meta.tags || [];
    const categoryName = meta.categoryName || "";
    const platforms = meta.platforms || { youtube: true, spotify: true, instagram: true };

    if (!fs.existsSync('temp/audio.mp3')) {
        throw new Error("❌ Local audio file (temp/audio.mp3) is missing!");
    }

    const itemIdentifier = `podcast-${Date.now()}`;
    const iaAccess = process.env.IA_ACCESS_KEY;
    const iaSecret = process.env.IA_SECRET_KEY;

    if (platforms.youtube) {
        if (!fs.existsSync('temp/horizontal.jpg')) {
            console.error("❌ temp/horizontal.jpg is missing for YouTube!");
        } else {
            console.log("🎬 Generating 16:9 horizontal video for YouTube...");
            execSync('ffmpeg -loop 1 -i temp/horizontal.jpg -i temp/audio.mp3 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest youtube.mp4 -y');

            const ytClientId = process.env.YT_CLIENT_ID;
            const ytClientSecret = process.env.YT_CLIENT_SECRET;
            const ytRefreshToken = process.env.YT_REFRESH_TOKEN;

            if (ytClientId && ytClientSecret && ytRefreshToken) {
                try {
                    console.log("📺 Uploading horizontal video to YouTube...");
                    await uploadToYouTube(ytClientId, ytClientSecret, ytRefreshToken, title, description, tags, categoryName);
                    console.log("✅ Published to YouTube successfully!");
                } catch (e) {
                    console.error("❌ YouTube publishing failed:", e.message);
                }
            } else {
                console.log("⚠️ YouTube credentials missing in Secrets!");
            }
        }
    }

    let archiveAudioUrl = "";
    let archiveSquareUrl = "";

    if (platforms.spotify) {
        if (!iaAccess || !iaSecret) {
            console.log("⚠️ IA_ACCESS_KEY or IA_SECRET_KEY missing for Spotify Archive upload!");
        } else {
            try {
                console.log("🏛️ Uploading MP3 to Archive.org for Spotify...");
                archiveAudioUrl = await uploadToArchive(itemIdentifier, 'temp/audio.mp3', 'audio.mp3', title, 'audio', 'opensource_audio', iaAccess, iaSecret);
                console.log("✅ Audio uploaded:", archiveAudioUrl);

                if (fs.existsSync('temp/square.jpg')) {
                    console.log("🏛️ Uploading 1:1 square cover to Archive.org for Spotify...");
                    archiveSquareUrl = await uploadToArchive(itemIdentifier, 'temp/square.jpg', 'square.jpg', title, 'audio', 'opensource_audio', iaAccess, iaSecret);
                    console.log("✅ Square cover uploaded:", archiveSquareUrl);
                }

                updateSpotifyFeed(title, description, archiveAudioUrl, archiveSquareUrl, fs.statSync('temp/audio.mp3').size);
                console.log("✅ feed.xml updated successfully for Spotify!");
            } catch (e) {
                console.error("❌ Spotify Archive upload or feed update failed:", e.response ? e.response.data : e.message);
            }
        }
    }

    if (platforms.instagram) {
        if (!fs.existsSync('temp/vertical.jpg')) {
            console.error("❌ temp/vertical.jpg is missing for Instagram/TikTok!");
        } else {
            console.log("🎬 Generating 9:16 vertical video for Instagram & TikTok...");
            execSync('ffmpeg -loop 1 -i temp/vertical.jpg -i temp/audio.mp3 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest vertical.mp4 -y');

            let verticalVideoUrl = "";
            if (iaAccess && iaSecret) {
                try {
                    console.log("🏛️ Uploading 9:16 vertical video to Archive.org...");
                    verticalVideoUrl = await uploadToArchive(itemIdentifier, 'vertical.mp4', 'vertical.mp4', title, 'movies', 'opensource_movies', iaAccess, iaSecret);
                    console.log("✅ Vertical video uploaded:", verticalVideoUrl);
                } catch (e) {
                    console.error("❌ Vertical video Archive.org upload failed:", e.response ? e.response.data : e.message);
                }
            }

            const makeWebhook = process.env.MAKE_WEBHOOK_URL;
            if (makeWebhook && verticalVideoUrl) {
                try {
                    console.log("🔗 Sending vertical video and metadata to Make.com (Instagram & Telegram)...");
                    const hashtags = tags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
                    await axios.post(makeWebhook, {
                        title: title,
                        description: description,
                        hashtags: hashtags,
                        caption: `${title}\n\n${description}\n\n${hashtags}`.trim(),
                        video_url: verticalVideoUrl,
                        audio_url: archiveAudioUrl,
                        tags: tags
                    });
                    console.log("✅ Make.com webhook triggered successfully!");
                } catch (e) {
                    console.error("❌ Make.com webhook failed:", e.message);
                }
            } else {
                console.log("⚠️ MAKE_WEBHOOK_URL or verticalVideoUrl is missing!");
            }
        }
    }

    fs.writeFileSync('temp/completed.flag', 'done');
    console.log("🧹 Marked temp files for cleanup.");
    console.log("🎉 All publishing tasks completed!");
}

function updateSpotifyFeed(title, description, audioUrl, imageUrl, audioSize) {
    if (!fs.existsSync('feed.xml')) {
        console.log("⚠️ feed.xml not found, skipping RSS update.");
        return;
    }

    let feed = fs.readFileSync('feed.xml', 'utf8');
    const pubDate = new Date().toUTCString();
    const guid = `ep-${Date.now()}`;
    const imageTag = imageUrl ? `\n      <itunes:image href="${imageUrl}"/>` : '';

    const newItem = `
    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[${description}]]></description>
      <enclosure url="${audioUrl}" length="${audioSize}" type="audio/mpeg"/>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>${imageTag}
    </item>`;

    if (feed.includes('<item>')) {
        feed = feed.replace('<item>', `${newItem.trim()}\n    <item>`);
    } else {
        feed = feed.replace('</channel>', `${newItem}\n  </channel>`);
    }

    fs.writeFileSync('feed.xml', feed, 'utf8');
}

async function uploadToYouTube(clientId, clientSecret, refreshToken, title, description, tags, categoryName) {
    const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: title.substring(0, 100),
                description: description,
                tags: tags,
                categoryId: '22'
            },
            status: {
                privacyStatus: 'public'
            }
        },
        media: {
            body: fs.createReadStream('youtube.mp4')
        }
    });

    const videoId = res.data.id;

    if (categoryName && videoId) {
        try {
            const playlistsRes = await youtube.playlists.list({
                part: 'snippet',
                mine: true,
                maxResults: 50
            });

            let playlist = playlistsRes.data.items.find(
                p => p.snippet.title.toLowerCase() === categoryName.toLowerCase()
            );

            if (!playlist) {
                const newPl = await youtube.playlists.insert({
                    part: 'snippet,status',
                    requestBody: {
                        snippet: { title: categoryName },
                        status: { privacyStatus: 'public' }
                    }
                });
                playlist = newPl.data;
            }

            await youtube.playlistItems.insert({
                part: 'snippet',
                requestBody: {
                    snippet: {
                        playlistId: playlist.id,
                        resourceId: {
                            kind: 'youtube#video',
                            videoId: videoId
                        }
                    }
                }
            });
            console.log(`📂 Added video to YouTube playlist: ${categoryName}`);
        } catch (plErr) {
            console.log("⚠️ Could not add to YouTube playlist:", plErr.message);
        }
    }
}

main().catch(err => {
    console.error("❌ Fatal Error:", err);
    process.exit(1);
});
