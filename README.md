# LangGraph SQL Agent

A PostgreSQL agent built with [LangGraph](https://langchain-ai.github.io/langgraph/) that converts natural language into SQL queries. It dynamically introspects database schemas and includes a self-correction loop to automatically fix SQL errors during execution.

## Features

- **Schema Introspection**: Reads `information_schema` at runtime to map tables and columns; no manual config required.
- **Error Recovery**: If a query fails (e.g., syntax error), the agent analyzes the Postgres error and retries the generation step.
- **Graph Workflow**: Uses a stateful cyclic graph (Introspect -> Generate -> Execute -> Refine).
- **Natural Language Output**: Summarizes the raw database results into a human-readable answer.

## Setup

1.  **Install dependencies**
    ```bash
    bun install
    ```

2.  **Environment**
    Create a `.env` file with your Groq API key:
    ```env
    GROQ_API_KEY=your_key_here
    ```

3.  **Run**
    ```bash
    bun run index.js
    ```
    The CLI will prompt for your Postgres credentials (host, user, db, etc.) upon start.

## Architecture

The agent follows this flow:
1.  **Introspection Node**: Fetches table definitions from the target schema.
2.  **Generate SQL Node**: Drafts a query based on the user prompt.
3.  **Execute SQL Node**: Runs the query.
    - *Success*: Moves to Refine.
    - *Error*: Feeds the error back to **Generate SQL** to fix the query.
4.  **Refine Response Node**: Formats the final output.

## Stack
- **Runtime**: Bun
- **Orchestration**: LangGraph, LangChain
- **Database**: PostgreSQL (`pg` driver)
- **LLM**: Llama 3 (via Groq)
