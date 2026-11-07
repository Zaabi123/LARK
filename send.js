// Send a Lark message to a customer through the running agent server.
//
//   npm run send -- --list                          list customers
//   npm run send -- user:<open_id> "Your text"      1-to-1 message (open_id starts with ou_)
//   npm run send -- chat:<chat_id> "Your text"      group message (chat_id starts with oc_)
//   npm run send -- email:<address> "Your text"     tenant member by work email
import "dotenv/config";

const base = `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3007}/lark`;
const headers = {
  Authorization: `Bearer ${process.env.AGENT_API_KEY}`,
  "Content-Type": "application/json",
};
const [first, ...rest] = process.argv.slice(2);

async function main() {
  if (!process.env.AGENT_API_KEY) throw new Error("AGENT_API_KEY is not set in .env.");

  if (first === "--list") {
    const response = await fetch(`${base}/customers`, { headers });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    const rows = Object.entries(body);
    if (rows.length === 0) return console.log("No customers yet. They appear after messaging your bot.");
    for (const [key, c] of rows) {
      console.log(`${key}  last seen ${c.lastSeen}  ${c.optedOut ? "[opted out]" : ""}`);
    }
    return;
  }

  const text = rest.join(" ").trim();
  if (!first || !text) {
    console.log(
      'Usage:\n  npm run send -- --list\n  npm run send -- user:<open_id> "Your message"\n  npm run send -- chat:<chat_id> "Your message"\n  npm run send -- email:<address> "Your message"',
    );
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${base}/send`, { method: "POST", headers, body: JSON.stringify({ to: first, text }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  console.log(`Sent to ${body.to} (id: ${body.id})`);
}

main().catch((error) => {
  console.error(error.cause?.code === "ECONNREFUSED" ? `Server is not running at ${base}. Start it with: npm start` : error.message);
  process.exitCode = 1;
});
