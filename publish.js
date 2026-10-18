const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');

async function main() {
    console.log("🚀 Starting podcast publishing pipeline...");

    const title = process.env.EPISODE_TITLE || "New Episode";
    const description = process.env.EPISODE_DESCRIPTION || "";
    const tagsEnv = process.env.EPISODE_TAGS || "";
    const tags = tagsEnv.split(',').map(t => t.trim()).filter(Boolean);

    if (!fs.existsSync('temp/audio.mp3')) {
        throw new Error("❌ Local audio file (temp/audio.mp3) is missing!");
    }

    console.log("📥 Preparing audio and image assets...");
    fs.copyFileSync('temp/audio.mp3', 'audio.mp3');

    if (fs.existsSync('temp/vertical.jpg')) {
        fs.copyFileSync('temp/vertical.jpg', 'cover.jpg');
    } else if (fs.existsSync('temp/horizontal.jpg')) {
        fs.copyFileSync('temp/horizontal.jpg', 'cover.jpg');
    } else {
        fs.writeFileSync('cover.jpg', Buffer.alloc(0));
    }

    // ساخت ویدیوها با FFmpeg
    console.log("🎬 Generating videos using FFmpeg...");
    const { execSync } = require('child_process');
    
    // ساخت ویدیوی افقی برای یوتیوب
    try {
        execSync('ffmpeg -loop 1 -i cover.jpg -i audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest output.mp4 -y');
    } catch (e) {
        console.log("⚠️ Horizontal video creation skipped:", e.message);
    }

    // ساخت ویدیوی عمودی برای اینستاگرام و تلگرام
    try {
        execSync('ffmpeg -loop 1 -i cover.jpg -i audio.mp3 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest vertical.mp4 -y');
    } catch (e) {
        console.log("⚠️ Vertical video creation skipped:", e.message);
    }

    // آپلود روی Archive.org
    let verticalVideoUrl = "";
    const itemIdentifier = `podcast-${Date.now()}`;
    const iaAccess = process.env.IA_ACCESS_KEY;
    const iaSecret = process.env.IA_SECRET_KEY;

    if (fs.existsSync('vertical.mp4') && iaAccess && iaSecret) {
        try {
            console.log(`🏛️ Uploading vertical video to Archive.org (${itemIdentifier})...`);
            const videoStream = fs.createReadStream('vertical.mp4');
            const videoSize = fs.statSync('vertical.mp4').size;

            await axios.put(`https://s3.us.archive.org/${itemIdentifier}/vertical.mp4`, videoStream, {
                headers: {
                    'Authorization': `LOW ${iaAccess}:${iaSecret}`,
                    'x-archive-auto-make-bucket': '1',
                    'x-archive-meta-mediatype': 'movies',
                    'x-archive-meta-collection': 'opensource_movies',
                    'x-archive-meta-title': title,
                    'x-archive-meta-creator': 'amir_hosseinzadeh843',
                    'Content-Length': videoSize
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            verticalVideoUrl = `https://archive.org/download/${itemIdentifier}/vertical.mp4`;
            console.log("✅ Vertical video uploaded to Archive.org:", verticalVideoUrl);
        } catch (e) {
            console.error("❌ Archive.org upload failed:", e.response ? e.response.data : e.message);
        }
    }

    // انتشار در یوتیوب
    if (process.env.YOUTUBE_CLIENT_ID && fs.existsSync('output.mp4')) {
        try {
            console.log("📺 Publishing to YouTube...");
            await uploadToYouTube(title, description, tags);
            console.log("✅ Published to YouTube successfully!");
        } catch (e) {
            console.error("❌ YouTube publishing failed:", e.message);
        }
    }

    // ارسال به Make.com (اینستاگرام و تلگرام)
    if (process.env.MAKE_WEBHOOK_URL) {
        try {
            console.log("🔗 Sending payload to Make.com webhook...");
            await axios.post(process.env.MAKE_WEBHOOK_URL, {
                title: title,
                description: description,
                audio_url: `https://archive.org/download/${itemIdentifier}/audio.mp3`,
                video_url: verticalVideoUrl,
                tags: tags
            });
            console.log("✅ Webhook triggered successfully!");
        } catch (e) {
            console.error("❌ Make.com webhook failed:", e.message);
        }
    }

    console.log("🎉 All publishing tasks completed!");
}

async function uploadToYouTube(title, description, tags) {
    const oauth2Client = new google.auth.OAuth2(
        process.env.YOUTUBE_CLIENT_ID,
        process.env.YOUTUBE_CLIENT_SECRET,
        'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    await youtube.videos.insert({
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
            body: fs.createReadStream('output.mp4')
        }
    });
}

main().catch(err => {
    console.error("❌ Fatal Error:", err);
    process.exit(1);
});
