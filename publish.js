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
    const platforms = meta.platforms || { youtube: true, spotify: true, instagram: false, tiktok: false };
    const epId = meta.timestamp || Date.now();

    if (platforms.youtube && fs.existsSync('temp/horizontal.jpg') && fs.existsSync('temp/audio.mp3')) {
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
                status: {
                    privacyStatus: 'public'
                }
            },
            media: {
                body: fs.createReadStream('youtube.mp4')
            }
        });
        console.log(`YouTube upload complete. ID: ${res.data.id}`);
    }

    if ((platforms.instagram || platforms.tiktok) && fs.existsSync('temp/vertical.jpg') && fs.existsSync('temp/audio.mp3')) {
        console.log("Generating 9:16 vertical video for Instagram / TikTok...");
        const vertCmd = 'ffmpeg -y -loop 1 -i temp/vertical.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -t 59 -shortest vertical.mp4';
        execSync(vertCmd, { stdio: 'inherit' });
    }

    if (platforms.spotify && fs.existsSync('temp/audio.mp3')) {
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
        const pubDate = new Date().toUTCString();

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

        const newItem = `
    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[${description}]]></description>
      <enclosure url="${audioUrl}" type="audio/mpeg" />
      <guid>${audioUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:image href="${coverUrl}" />
    </item>`;

        feed = feed.replace('</channel>', `${newItem}\n  </channel>`);
        fs.writeFileSync('feed.xml', feed);
        console.log("Spotify RSS feed updated.");
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
