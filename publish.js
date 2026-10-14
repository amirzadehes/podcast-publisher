const fs = require('fs');
const { google } = require('googleapis');
const { execSync } = require('child_process');

async function run() {
    console.log("Starting podcast publishing process...");

    // خواندن اطلاعات متنی (عنوان، توضیحات و تگ‌ها) که از وب‌اپلیکیشن ارسال شده
    let episodeTitle = "پادکست جدید";
    let episodeDescription = "توضیحات اپیزود";
    let episodeTags = ["پادکست"];

    if (fs.existsSync('temp/meta.json')) {
        const meta = JSON.parse(fs.readFileSync('temp/meta.json', 'utf8'));
        if (meta.title) episodeTitle = meta.title;
        if (meta.description) episodeDescription = meta.description;
        if (meta.tags && Array.isArray(meta.tags)) episodeTags = meta.tags;
    }

    // ساخت ویدیو با استفاده از FFmpeg
    console.log("Generating video...");
    const ffmpegCmd = 'ffmpeg -y -loop 1 -i temp/horizontal.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -shortest youtube.mp4';
    execSync(ffmpegCmd, { stdio: 'inherit' });

    // اتصال به یوتیوب با استفاده از توکن‌ها
    const oauth2Client = new google.auth.OAuth2(
        process.env.YT_CLIENT_ID,
        process.env.YT_CLIENT_SECRET,
        "https://developers.google.com/oauthplayground"
    );

    oauth2Client.setCredentials({
        refresh_token: process.env.YT_REFRESH_TOKEN
    });

    const youtube = google.youtube({
        version: 'v3',
        auth: oauth2Client
    });

    console.log("Uploading to YouTube with tags and description...");
    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: episodeTitle,
                description: episodeDescription,
                tags: episodeTags,
                categoryId: '22' // دسته‌بندی People & Blogs
            },
            status: {
                privacyStatus: 'public'
            }
        },
        media: {
            body: fs.createReadStream('youtube.mp4')
        }
    });

    console.log(`Successfully uploaded to YouTube. Video ID: ${res.data.id}`);

    // بروزرسانی فید RSS برای اسپاتیفای
    updateFeed(episodeTitle, episodeDescription);
}

function updateFeed(title, description) {
    const pubDate = new Date().toUTCString();
    let feed = '';
    
    if (fs.existsSync('feed.xml')) {
        feed = fs.readFileSync('feed.xml', 'utf8');
    } else {
        feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>پادکست من</title>
    <link>https://amirzadehes.github.io/podcast-publisher/</link>
    <description>فید پادکست</description>
    <language>fa</language>
  </channel>
</rss>`;
    }

    const newItem = `
    <item>
      <title><![CDATA[${title}]]></title>
      <description><![CDATA[${description}]]></description>
      <pubDate>${pubDate}</pubDate>
    </item>`;

    feed = feed.replace('</channel>', `${newItem}\n  </channel>`);
    fs.writeFileSync('feed.xml', feed);
    console.log("RSS feed updated successfully.");
}

run().catch(console.error);
