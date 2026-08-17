"""Long-lived JSON-lines bridge to ThetaData's official Python client."""

import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from thetadata import ThetaClient
from thetadata.errors import NoDataFoundError


def serializable(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):
        return value.item()
    return value


def rows(frame):
    if hasattr(frame, "to_dicts"):
        return frame.to_dicts()
    return frame.to_dict(orient="records")


def main():
    key = os.environ.get("THETADATA_API_KEY", "").strip()
    if not key:
        raise RuntimeError("No ThetaData API key configured")
    client = ThetaClient(api_key=key, dataframe_type="polars")

    output_lock = threading.Lock()
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="thetadata")

    def handle(request):
        request_id = request.get("id")
        try:
            operation = request["operation"]
            payload = request.get("payload", {})
            if operation == "test":
                frame = client.option_list_expirations(symbol="SPX")
                result = {"expirations": len(frame)}
            elif operation == "contracts":
                expiration = date.fromisoformat(payload["expiration"])
                result = []
                # OPRA uses separate roots for settlement style. Preserve both;
                # the study's preferredRoot setting selects SPXW by default.
                symbols = ["SPX", "SPXW"] if payload["underlying"].upper() == "SPX" else [payload["underlying"].upper()]
                for symbol in symbols:
                    try:
                        frame = client.option_list_strikes(symbol=symbol, expiration=expiration)
                        for row in rows(frame):
                            result.append({"symbol": symbol, "expiration": payload["expiration"], "strike": row["strike"]})
                    except Exception:
                        # A root not listing this expiration is normal (for
                        # example SPX on most weekly expiration dates).
                        continue
            elif operation == "quotes":
                try:
                    frame = client.option_history_quote(
                        symbol=payload["symbol"],
                        expiration=date.fromisoformat(payload["expiration"]),
                        strike=str(payload["strike"]),
                        right=payload["right"],
                        start_date=date.fromisoformat(payload["from"]),
                        end_date=date.fromisoformat(payload["to"]),
                        start_time="09:30:00",
                        end_time="16:00:00",
                        interval="1m",
                    )
                    result = rows(frame)
                except NoDataFoundError:
                    # Absence is market data: this contract had no NBBO quote
                    # on the requested day. The cache must record an empty day
                    # rather than aborting the entire study or retrying forever.
                    result = []
            else:
                raise ValueError(f"Unknown operation: {operation}")
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:  # errors must cross the process boundary cleanly
            response = {"id": request_id, "ok": False, "error": str(exc)}
        with output_lock:
            print(json.dumps(response, default=serializable, separators=(",", ":")), flush=True)

    for line in sys.stdin:
        request = json.loads(line)
        executor.submit(handle, request)


if __name__ == "__main__":
    main()
