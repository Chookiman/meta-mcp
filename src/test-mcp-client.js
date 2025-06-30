// test-http.js
import fetch from 'node:fetch';    // works in Node v22+

const URL = 'http://localhost:3001/tool/get_account_overview';

const body = {
  dateRange: 'last_7d',
  sendNotification: false,
};

(async () => {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    console.log('✅ Response received:\n', JSON.stringify(json, null, 2));
  } catch (err) {
    console.error('❌ Request failed:', err.message);
  }
})();