"""Send a Lark message to a customer through the running API.

  python send.py --list                          list customers
  python send.py user:<open_id> "Your text"      1-to-1 message (open_id starts with ou_)
  python send.py chat:<chat_id> "Your text"      group message (chat_id starts with oc_)
  python send.py email:<address> "Your text"     tenant member by work email
  python send.py --url https://lark-backend.onrender.com user:ou_... "Text"   use a deployed API
"""
import os
import sys

import httpx
from dotenv import load_dotenv

load_dotenv()


def main(argv: list[str]) -> int:
    base = f"http://{os.getenv('HOST', '127.0.0.1')}:{os.getenv('PORT', '3007')}"
    if argv[:1] == ["--url"] and len(argv) > 1:
        base, argv = argv[1].rstrip("/"), argv[2:]
    key = os.getenv("AGENT_API_KEY")
    if not key:
        print("AGENT_API_KEY is not set in .env.")
        return 1
    headers = {"Authorization": f"Bearer {key}"}
    try:
        if argv[:1] == ["--list"]:
            r = httpx.get(f"{base}/lark/customers", headers=headers, timeout=30)
            body = r.json()
            if r.status_code >= 400:
                print(body.get("error"))
                return 1
            if not body:
                print("No customers yet. They appear after messaging your bot.")
            for k, c in body.items():
                print(f"{k}  last seen {c.get('lastSeen')}  {'[opted out]' if c.get('optedOut') else ''}")
            return 0
        if len(argv) < 2:
            print(__doc__)
            return 1
        r = httpx.post(f"{base}/lark/send", headers=headers, json={"to": argv[0], "text": " ".join(argv[1:])}, timeout=30)
        body = r.json()
        if r.status_code >= 400:
            print(body.get("error"))
            return 1
        print(f"Sent to {body['to']} (id: {body['id']})")
        return 0
    except httpx.ConnectError:
        print(f"Server is not running at {base}. Start it with: python -m app.main")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
