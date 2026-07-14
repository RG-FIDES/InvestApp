Role

Act as an expert Senior Python Data Engineer and Backend Developer specializing in high-performance financial systems.

Objective

Build the backend for a real-time stock tracking simulator for Micron Technology (MU). The backend must solve the "15-minute REST API gap" inherent in Alpaca's free tier by maintaining a persistent "shadow database" via a 24/7 WebSocket listener.

Tech Stack

Language: Python 3.10+

Web Framework: FastAPI

Database: SQLite (via aiosqlite or sqlite3)

External API: alpaca-py (Alpaca Markets Python SDK)

File Structure

Organize the code into the following files:

database.py: Database connection, schema creation, and queries.

ingestion.py: The daemon that connects to the Alpaca WebSocket.

main.py: The FastAPI application, REST routes, and WebSocket endpoints.

requirements.txt: Necessary dependencies.

Core Requirements

1. Database Schema (database.py)

Create a SQLite database named market_data.db.

Create a table mu_1min_bars with the following columns:

timestamp (DATETIME, Primary Key)

open (REAL)

high (REAL)

low (REAL)

close (REAL)

volume (INTEGER)

Implement an async function to insert a new 1-minute bar.

Implement an async query to fetch the last 3 months of data.

VWAP Calculation: Implement an async function that calculates the 3-day Volume-Weighted Average Price using SQL. The formula logic is: SUM(close * volume) / SUM(volume) filtered for the last 3 trading days.

2. Ingestion Daemon (ingestion.py)

Use alpaca-py to connect to the live crypto/stock WebSocket (Free Tier).

Subscribe to 1-minute bars for the symbol MU.

Whenever a new 1-minute bar arrives, insert it into the mu_1min_bars SQLite database.

Use asyncio to ensure this runs as a continuous background task without blocking the main server.

3. FastAPI Server (main.py)

Background Task: On application startup, spawn the ingestion.py listener as an asyncio background task.

Endpoint 1 (GET /api/history): Retrieve the historical dataset directly from the SQLite database (do NOT call the Alpaca REST API) and return it as JSON to seed the frontend chart.

Endpoint 2 (WS /ws/live): Create a FastAPI WebSocket endpoint.

Accept connections from the React frontend.

When a new tick is saved to the DB by the ingestion daemon, push that new JSON data to all connected WebSocket clients.

Listen for JSON messages from the client in the format {"action": "set_alert", "price": 138.00}. Store this threshold in memory.

If the newly ingested 'close' price crosses the user's defined alert threshold, push a message back to the client: {"type": "alert", "message": "Price crossed threshold!"}.

Design Constraints

Ensure proper asyncio event loops so the database writes from the Alpaca stream do not block the WebSocket broadcasts to the frontend.

Add comprehensive comments explaining the data flow.

Provide the command to run the server using uvicorn.