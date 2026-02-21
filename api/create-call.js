// api/create-call.js
export default async function handler(req, res) {
  // 1. Security Check: Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // 2. Get Secrets from Vercel Environment Variables
  const apiKey = process.env.key_517db56ff4eeaea14f5978bb3ba4;
  
  // 3. YOUR AGENT ID (I took this from your HTML snippet)
  const agentId = 'oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD';

  if (!apiKey) {
    return res.status(500).json({ error: "Missing API Key in Vercel Settings" });
  }

  try {
    // 4. Request the call from Retell
    const response = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ agent_id: agentId }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Retell API Error: ${errorText}`);
    }

    const data = await response.json();
    
    // 5. Send the Access Token back to the frontend
    return res.status(200).json(data);

  } catch (error) {
    console.error("Backend Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
