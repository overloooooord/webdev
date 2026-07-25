// AI Assistant — Generates suggested replies for Ubisoft support tickets
// Uses OpenRouter (openrouter.ai) as the AI gateway — one API key, access to all models
import { getSetting } from './database.js';

// OpenRouter API endpoint — works like OpenAI's API but routes to any model
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `You are a Ubisoft account holder contacting support to recover access to your account that was linked to a stolen/compromised gaming platform (Xbox or PlayStation) account.

Your goal is to get Ubisoft support to UNLINK the old platform account from your Ubisoft account so you can link a new one.

Key facts you should convey naturally:
- You lost access to your old Xbox/PlayStation account
- You want to unlink the old platform account from your Ubisoft profile
- You are the legitimate owner and can verify via email
- Be polite but firm
- Keep responses SHORT (2-4 sentences max)
- Sound like a real person, not a bot
- Use casual English, occasional typos are fine
- If the agent asks for verification, agree and provide what they need
- Never mention automation, bots, or scripts

Reply ONLY with the suggested message text. No quotes, no labels, no explanation.`;

/**
 * Get AI-suggested reply for a ticket conversation
 * @param {Array} messages - Previous messages in the conversation
 * @param {Object} context - Account/ticket context
 * @returns {Promise<{success: boolean, suggestion?: string, error?: string}>}
 */
export async function getSuggestedReply(messages, context = {}) {
  const apiKey = getSetting('ai_api_key');

  if (!apiKey) {
    return { success: false, error: 'No OpenRouter API key configured. Set it in Settings.' };
  }

  // Default model: DeepSeek V3 (best price/quality for this task)
  const model = getSetting('ai_model') || 'deepseek/deepseek-chat-v3-0324';

  try {
    // Build chat history — map our message format to OpenAI chat format
    const chatHistory = messages.map(m => ({
      role: m.created_by === 'Ubisoft Agent' ? 'assistant' : 'user',
      content: m.body || '',
    }));

    // Add context about the account so the AI knows the situation
    let contextNote = '';
    if (context.platform) contextNote += `Platform: ${context.platform}. `;
    if (context.username) contextNote += `Username: ${context.username}. `;
    if (context.contactEmail) contextNote += `Contact email: ${context.contactEmail}. `;

    const systemMsg = SYSTEM_PROMPT + (contextNote ? `\n\nAccount context: ${contextNote}` : '');

    const body = {
      model,
      messages: [
        { role: 'system', content: systemMsg },
        ...chatHistory,
      ],
      temperature: 0.8,
      max_tokens: 200,
    };

    console.log(`[AI] Requesting suggestion via OpenRouter (model: ${model})...`);

    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://ticket-manager.local',  // Required by OpenRouter
        'X-Title': 'Ticket Manager',                     // Shows in OpenRouter dashboard
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[AI] OpenRouter error (${res.status}):`, errText);
      return { success: false, error: `API error ${res.status}: ${errText.substring(0, 200)}` };
    }

    const data = await res.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim();

    if (!suggestion) {
      return { success: false, error: 'Empty response from AI' };
    }

    console.log(`[AI] Suggestion generated (${suggestion.length} chars)`);
    return { success: true, suggestion };

  } catch (err) {
    console.error('[AI] Exception:', err.message);
    return { success: false, error: err.message };
  }
}
