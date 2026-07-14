"""Quick diagnostic — check feed.new code in isolation."""
import asyncio
import feed
import db
import config

async def main():
    await db.init_db()
    print("config.MARKET_TIMEZONE =", repr(config.MARKET_TIMEZONE))
    print("config.MARKET_DISPLAY  =", repr(config.MARKET_DISPLAY))
    daily = await feed.get_daily_history()
    print("daily length:", len(daily) if daily else 0)
    if daily:
        print("last 3 close:", [b["close"] for b in daily[-3:]])
        print("last 3 volume:", [b["volume"] for b in daily[-3:]])
    quote = await feed.build_quote()
    print()
    print("quote keys:", list(quote.keys()))
    print("avgPrice3d:", quote.get("avgPrice3d"))
    print("avgVolume3d:", quote.get("avgVolume3d"))
    print("avgPrice3m:", quote.get("avgPrice3m"))
    print("avgVolume3m:", quote.get("avgVolume3m"))
    print("avgVolume:", quote.get("avgVolume"))
    print("marketTimezone:", quote.get("marketTimezone"))

asyncio.run(main())
