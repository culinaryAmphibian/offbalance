"""Dev only: wait for a provider's benchmark to reach the server, then set its hourly price.

A provider is only matched once it has posted /scores (the client does) and set a price,
so start-demo.ps1 runs this for each provider it launches.

    python dev/set_price.py dev2 0.5        # API key, ETH per hour
"""
import argparse
import os
import sys
import time

import requests


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('api_key', help="provider API key: dev, dev2, dev3 or dev4 after `npm run seed`")
    parser.add_argument('price', help="ETH per hour")
    parser.add_argument('--server', default=os.environ.get('OFFBALANCE_SERVER_URL', 'https://localhost:5000'))
    parser.add_argument('--wait', type=float, default=120, help="seconds to wait for the benchmark (default 120)")
    args = parser.parse_args()

    session = requests.Session()
    session.headers['Authorization'] = f"Bearer {args.api_key}"
    deadline = time.monotonic() + args.wait
    while True:
        try:
            res = session.get(f"{args.server}/provider/hardware", timeout=5)
            if res.ok and res.json().get('hardware'):
                break
        except requests.ConnectionError:
            pass
        if time.monotonic() > deadline:
            sys.exit(f"{args.api_key}: no benchmark after {args.wait:.0f}s; is its client running?")
        time.sleep(2)

    res = session.post(f"{args.server}/provider/price", json={'price': args.price}, timeout=5)
    if not res.ok:
        sys.exit(f"{args.api_key}: setting price failed ({res.status_code}): {res.text}")
    print(f"{args.api_key}: price set to {args.price} ETH/hour")


if __name__ == '__main__':
    main()
