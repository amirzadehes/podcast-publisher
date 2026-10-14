const fs = require('fs');
const { execSync } = require('child_process');

async function run() {
  if (!fs.existsSync('temp/meta.json')) {
    console.log('No meta.json found');
    return;
  }
  const meta = JSON.parse(fs.readFileSync('temp/meta.json', 'utf8'));
  const tag = 'ep-' + Date.now();
  const repo = process.env.GITHUB_REPOSITORY;

  if (fs.existsSync('temp/horizontal.jpg') && fs.existsSync('temp/audio.mp3')) {
    execSync('ffmpeg -y -loop 1 -i temp/horizontal.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -shortest youtube.mp4', { stdio: 'inherit' });
  }

  if (fs.existsSync('temp/vertical.jpg') && fs.existsSync('temp/audio.mp3')) {
    execSync('ffmpeg -y -loop 1 -i temp/vertical.jpg -i temp/audio.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -shortest vertical.mp4', { stdio: 'inherit' });
  }

  const assets = [];
  if (fs.existsSync('temp/audio.mp3')) assets.push('temp/audio.mp3');
  if (fs.existsSync('temp/square.jpg')) assets.push('temp/square.jpg');
  if (fs.existsSync('vertical.mp4')) assets.push('vertical.mp4');
  if (fs.existsSync('youtube.mp4')) assets.push('youtube.mp4');

  execSync('gh release create ' + tag + ' ' + assets.join(' ') + ' --title ' + JSON.stringify(meta.title) + ' --notes ' + JSON.stringify(meta.description || ''), { stdio: 'inherit' });

  const baseReleaseUrl = 'https://github.com/' + repo + '/releases/download/' + tag;
  const audioUrl = baseReleaseUrl + '/audio.mp3';
  const squareUrl = baseReleaseUrl + '/square.jpg';
  const verticalUrl = baseReleaseUrl + '/vertical.mp4';

  if (meta.platforms && meta.platforms.spotify && fs.existsSync('feed.xml')) {
    const audioSize = fs.existsSync('temp/audio.mp3') ? fs.statSync('temp/audio.mp3').size : 0;
    const pubDate = new Date().toUTCString();
    const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const newItem = [
      '    <item>',
      '      <title>' + esc(meta.title) + '</title>',
      '      <description>' + esc(meta.description) + '</description>',
      '      <pubDate>' + pubDate + '</pubDate>',
      '      <enclosure url="' + audioUrl + '" length="' + audioSize + '" type="audio/mpeg"/>',
      '      <guid isPermaLink="false">' + tag + '</guid>',
      '      <itunes:image href="' + squareUrl + '"/>',
      '    </item>',
      '  </channel>'
    ].join('\n');
    const feedContent = fs.readFileSync('feed.xml', 'utf8').replace('</channel>', newItem);
    fs.writeFileSync('feed.xml', feedContent, 'utf8');
  }

  if (meta.platforms && meta.platforms.youtube && process.env.YT_REFRESH_TOKEN && fs.existsSync('youtube.mp4')) {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.YT_CLIENT_ID,
        client_secret: process.env.YT_CLIENT_SECRET,
        refresh_token: process.env.YT_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + tokenData.access_token,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4'
        },
        body: JSON.stringify({
          snippet: { title: meta.title, description: meta.description, categoryId: '22' },
          status: { privacyStatus: 'public' }
        })
      });
      const uploadUrl = initRes.headers.get('location');
      if (uploadUrl) {
        const videoBuffer = fs.readFileSync('youtube.mp4');
        const upRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'video/mp4' },
          body: videoBuffer
        });
        const videoData = await upRes.json();
        if (videoData.id && fs.existsSync('temp/horizontal.jpg')) {
          await fetch('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=' + videoData.id + '&uploadType=media', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + tokenData.access_token,
              'Content-Type': 'image/jpeg'
            },
            body: fs.readFileSync('temp/horizontal.jpg')
          });
        }
      }
    }
  }

  if (meta.platforms && meta.platforms.instagram && process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN) {
    const createRes = await fetch('https://graph.facebook.com/v20.0/' + process.env.IG_USER_ID + '/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: verticalUrl,
        caption: meta.title + '\n\n' + (meta.description || ''),
        access_token: process.env.IG_ACCESS_TOKEN
      })
    });
    const createData = await createRes.json();
    if (createData.id) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const stRes = await fetch('https://graph.facebook.com/v20.0/' + createData.id + '?fields=status_code&access_token=' + process.env.IG_ACCESS_TOKEN);
        const stData = await stRes.json();
        if (stData.status_code === 'FINISHED') {
          await fetch('https://graph.facebook.com/v20.0/' + process.env.IG_USER_ID + '/media_publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              creation_id: createData.id,
              access_token: process.env.IG_ACCESS_TOKEN
            })
          });
          break;
        }
        if (stData.status_code === 'ERROR') break;
      }
    }
  }
}

run().catch(err => { console.error(err); process.exit(1); });