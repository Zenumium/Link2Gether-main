import fetch from 'node-fetch';

export default async function handler(req, res) {
  const code = req.query.code;

  if (!code) {
    res.status(400).json({ error: 'Missing code parameter' });
    return;
  }

  const clientId = '1379082773410873356';
  const clientSecret = 'u3mhs7s5ud_k--YfMSji2VeNswCOwrXe';
  const redirectUri = 'http://localhost:3000/api/discord-auth';

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        scope: 'identify',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      res.status(500).json({ error: 'Failed to get access token', details: errorData });
      return;
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Fetch user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResponse.ok) {
      const errorData = await userResponse.json();
      res.status(500).json({ error: 'Failed to fetch user info', details: errorData });
      return;
    }

    const userData = await userResponse.json();

    // Redirect to main page with username, user ID, and avatar hash as query params
    const redirectUrl = `http://localhost:3000/?username=${encodeURIComponent(userData.username)}&userId=${encodeURIComponent(userData.id)}&avatar=${encodeURIComponent(userData.avatar)}`;
    res.writeHead(302, { Location: redirectUrl });
    res.end();

  } catch (error) {
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
