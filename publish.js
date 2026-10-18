const fs = require('fs');
const path = require('path');
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

async function processJob(jobDir) {
    const metaPath = path.join(jobDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return;

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    if (meta.publishAt) {
        const publishTime = new Date(meta.publishAt).getTime();
        if (Date.now() < publishTime) {
            console.log(`⏳ Job in ${jobDir} is scheduled for ${meta.publishAt}. Skipping for now.`);
            return;
        }
    }

    const title = meta.title || "New Episode";
    const description = meta.description || "";
    const tags = meta.tags || [];
    const categoryName = meta.categoryName || "";
    const podcastId = meta.podcastId || "zarebin";
    const platforms = meta.platforms || { youtube: true, spotify: true, instagram: true };
    meta.done = meta.done || { youtube: false, spotify: false, instagram: false };

    const audioPath = path.join(jobDir, 'audio.mp3');
    const horizontalPath = path.join(jobDir, 'horizontal.jpg');
    const verticalPath = path.join(jobDir, 'vertical.jpg');
    const squarePath = path.join(jobDir, 'square.jpg');

    if (!fs.existsSync(audioPath)) {
        throw new Error(`❌ Audio file missing in ${jobDir}`);
    }

    const itemIdentifier = `podcast-${meta.timestamp || Date.now()}`;
    const iaAccess = process.env.IA_ACCESS_KEY;
    const iaSecret = process.env.IA_SECRET_KEY;

    if (platforms.youtube && !meta.done.youtube) {
        if (!fs.existsSync(horizontalPath)) {
            console.error(`❌ horizontal.jpg is missing in ${jobDir} for YouTube!`);
        } else {
            const ytVideoPath = path.join(jobDir, 'youtube.mp4');
            console.log(`🎬 Generating 16:9 horizontal video for YouTube (${title})...`);
            execSync(`ffmpeg -loop 1 -i "${horizontalPath}" -i "${audioPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest "${ytVideoPath}" -y`);

            const ytClientId = process.env.YT_CLIENT_ID;
            const ytClientSecret = process.env.YT_CLIENT_SECRET;
            const ytRefreshToken = process.env.YT_REFRESH_TOKEN;

            if (ytClientId && ytClientSecret && ytRefreshToken) {
                try {
                    console.log("📺 Uploading horizontal video to YouTube...");
                    await uploadToYouTube(ytClientId, ytClientSecret, ytRefreshToken, ytVideoPath, title, description, tags, categoryName);
                    meta.done.youtube = true;
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                    console.log("✅ Published to YouTube successfully!");
                } catch (e) {
                    console.error("❌ YouTube publishing failed:", e.message);
                }
            }
            if (fs.existsSync(ytVideoPath)) fs.unlinkSync(ytVideoPath);
        }
    }

    let archiveAudioUrl = meta.archiveAudioUrl || "";
    let archiveSquareUrl = meta.archiveSquareUrl || "";

    if (platforms.spotify && !meta.done.spotify) {
        if (iaAccess && iaSecret) {
            try {
                console.log("🏛️ Uploading MP3 to Archive.org for Spotify...");
                archiveAudioUrl = await uploadToArchive(itemIdentifier, audioPath, 'audio.mp3', title, 'audio', 'opensource_audio', iaAccess, iaSecret);
                meta.archiveAudioUrl = archiveAudioUrl;

                if (fs.existsSync(squarePath)) {
                    console.log("🏛️ Uploading 1:1 square cover to Archive.org for Spotify...");
                    archiveSquareUrl = await uploadToArchive(itemIdentifier, squarePath, 'square.jpg', title, 'audio', 'opensource_audio', iaAccess, iaSecret);
                    meta.archiveSquareUrl = archiveSquareUrl;
                }

                updateSpotifyFeed(title, description, archiveAudioUrl, archiveSquareUrl, fs.statSync(audioPath).size);
                meta.done.spotify = true;
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                console.log("✅ feed.xml updated successfully for Spotify!");
            } catch (e) {
                console.error("❌ Spotify upload failed:", e.response ? e.response.data : e.message);
            }
        }
    }

    if (platforms.instagram && !meta.done.instagram) {
        if (!fs.existsSync(verticalPath)) {
            console.error(`❌ vertical.jpg is missing in ${jobDir} for Instagram/TikTok!`);
        } else {
            const vertVideoPath = path.join(jobDir, 'vertical.mp4');
            console.log(`🎬 Generating 9:16 vertical video for Instagram & TikTok (${title})...`);
            execSync(`ffmpeg -loop 1 -i "${verticalPath}" -i "${audioPath}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest "${vertVideoPath}" -y`);

            let verticalVideoUrl = "";
            if (iaAccess && iaSecret) {
                try {
                    console.log("🏛️ Uploading 9:16 vertical video to Archive.org...");
                    verticalVideoUrl = await uploadToArchive(itemIdentifier, vertVideoPath, 'vertical.mp4', title, 'movies', 'opensource_movies', iaAccess, iaSecret);
                    console.log("✅ Vertical video uploaded:", verticalVideoUrl);
                } catch (e) {
                    console.error("❌ Vertical video Archive.org upload failed:", e.response ? e.response.data : e.message);
                }
            }

            if (fs.existsSync(vertVideoPath)) fs.unlinkSync(vertVideoPath);

            const makeWebhook = process.env.MAKE_WEBHOOK_URL;
            if (makeWebhook && verticalVideoUrl) {
                try {
                    console.log("⏳ Waiting 15 seconds for Archive.org link propagation...");
                    await new Promise(r => setTimeout(r, 15000));

                    console.log("🔗 Sending payload to Make.com webhook...");
                    const hashtags = tags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
                    await axios.post(makeWebhook, {
                        podcastId: podcastId,
                        podcast_id: podcastId,
                        Podcast_id: podcastId,
                        title: title,
                        description: description,
                        hashtags: hashtags,
                        caption: `${title}\n\n${description}\n\n${hashtags}`.trim(),
                        video_url: verticalVideoUrl,
                        videoUrl: verticalVideoUrl,
                        audio_url: archiveAudioUrl,
                        tags: tags,
                        categoryName: categoryName
                    });
                    meta.done.instagram = true;
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                    console.log("✅ Make.com webhook triggered successfully!");
                } catch (e) {
                    console.error("❌ Make.com webhook failed:", e.message);
                }
            }
        }
    }

    const allCompleted =
        (!platforms.youtube || meta.done.youtube) &&
        (!platforms.spotify || meta.done.spotify) &&
        (!platforms.instagram || meta.done.instagram);

    if (allCompleted) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        console.log(`🧹 Cleaned up completed job folder: ${jobDir}`);
    }
}

async function main() {
    console.log("🚀 Starting podcast publishing pipeline...");

    const jobDirs = [];

    if (fs.existsSync('temp/meta.json')) {
        jobDirs.push('temp');
    }

    if (fs.existsSync('jobs')) {
        const subdirs = fs.readdirSync('jobs');
        for (const dir of subdirs) {
            const fullPath = path.join('jobs', dir);
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'meta.json'))) {
                jobDirs.push(fullPath);
            }
        }
    }

    if (jobDirs.length === 0) {
        console.log("📭 No pending jobs found.");
        return;
    }

    for (const dir of jobDirs) {
        await processJob(dir);
    }

    console.log("🎉 All due publishing tasks completed!");
}

function updateSpotifyFeed(title, description, audioUrl, imageUrl, audioSize) {
    if (!fs.existsSync('feed.xml')) return;

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

async function uploadToYouTube(clientId, clientSecret, refreshToken, videoPath, title, description, tags, categoryName) {
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
            body: fs.createReadStream(videoPath)
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
        } catch (plErr) {
            console.log("⚠️ Could not add to YouTube playlist:", plErr.message);
        }
    }
}

main().catch(err => {
    console.error("❌ Fatal Error:", err);
    process.exit(1);
});
