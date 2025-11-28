import * as dotenv from "dotenv";
import { ChatGroq } from "@langchain/groq";
import { StateGraph, START, END, MemorySaver, Annotation } from "@langchain/langgraph";
import { Client } from "pg";
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";

dotenv.config();

// --- Configuration ---
const MAX_RETRIES = 5;

// Global variables for DB connection and Schema
let dbClient;
let targetSchema = "public"; // Default to public

// --- 1. Define the Graph State (Using Annotation) ---
const GraphState = Annotation.Root({
    // Messages: Appends new messages to the history array
    messages: Annotation({
        reducer: (x, y) => x.concat(y),
        default: () => [],
    }),
    // Schema: Overwrites with new value
    schema_context: Annotation({
        reducer: (x, y) => y ?? x,
        default: () => null,
    }),
    // Current Question: Overwrites
    current_question: Annotation({
        reducer: (x, y) => y ?? x,
        default: () => "",
    }),
    // SQL Query: Overwrites
    sql_query: Annotation({
        reducer: (x, y) => y ?? x,
        default: () => null,
    }),
    // DB Result: Overwrites
    db_result: Annotation({
        reducer: (x, y) => y ?? x,
        default: () => null,
    }),
    // Error: Overwrites
    error: Annotation({
        reducer: (x, y) => y ?? x,
        default: () => null,
    }),
    // Retry Count: Overwrites
    retry_count: Annotation({
        reducer: (x, y) => y ?? x,
        default: () => 0,
    }),
});

// --- 2. Initialize Core Components ---
if (!process.env.GROQ_API_KEY) {
    console.error("❌ Error: GROQ_API_KEY is missing in .env file.");
    process.exit(1);
}

const llm = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "openai/gpt-oss-120b",
    temperature: 0,
});

const memory = new MemorySaver();

// --- 3. Define the Nodes ---

async function introspectionNode(state) {
    if (state.schema_context) return {}; 

    console.log(`\n🔍 Introspecting database schema: '${targetSchema}'...`);
    
    // DYNAMIC SCHEMA INJECTION HERE
    // We filter by table_schema = targetSchema
    const introspectionQuery = `
        SELECT table_name, column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = '${targetSchema}' 
        ORDER BY table_name, ordinal_position;
    `;

    try {
        const res = await dbClient.query(introspectionQuery);
        if (res.rows.length === 0) return { error: `No tables found in schema '${targetSchema}'.` };

        let schema = `Database Schema (${targetSchema}): (NOTE: ALL NAMES ARE CASE SENSITIVE AND MUST BE QUOTED)\n`; // <-- ADDED NOTE
        let currentTable = "";
        res.rows.forEach(row => {
            if (row.table_name !== currentTable) {
                currentTable = row.table_name;
                schema += `\nTable: ${currentTable}\nColumns:\n`;
            }
            schema += `- ${row.column_name} (${row.data_type})\n`;
        });

        console.log("✅ Schema learned.");
        return { schema_context: schema };
    } catch (err) {
        return { error: `Introspection Failed: ${err.message}` };
    }
}

async function generateSqlNode(state) {
    const { schema_context, current_question, messages, error, retry_count } = state;

    if (!schema_context) return { error: "Schema context missing." };

    console.log(`\n🤖 Attempt ${retry_count + 1}: Generating SQL...`);

    const historyText = messages.map(m => 
        `${m._getType() === 'human' ? 'User' : 'Assistant'}: ${m.content}`
    ).join("\n");

   const systemPrompt = `
        You are an expert PostgreSQL Query Generator.
        
        ${schema_context}

        INSTRUCTIONS:
        1. **CRITICAL:** Use double quotes and the exact casing provided in the SCHEMA for all table and column names (e.g., SELECT "Task"."id" FROM "Task").
        2. Generate a valid PostgreSQL query based on the User's Request.
        3. Since this query must be portable, you MUST prefix all table names with the schema name '${targetSchema}' (e.g., use '${targetSchema}."users"' instead of '"users"').
        4. If an ERROR is provided, fix the specific error.
        5. Return ONLY the SQL query. No markdown.
    `;

    const userContent = `
        Conversation History:
        ${historyText}

        Current User Request: "${current_question}"
        ${error ? `PREVIOUS ERROR (Fix this): "${error}"` : ""}
    `;

    const result = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userContent)
    ]);

    const sqlQuery = result.content.trim().replace(/^```[a-z]*\n?|```$/gmi, '').trim().replace(/;$/, ''); 

    return {
        sql_query: sqlQuery,
        error: null,
        retry_count: retry_count + 1
    };
}

async function executeSqlNode(state) {
    const { sql_query } = state;
    if (!sql_query) return { error: "No SQL generated." };

    console.log(`\nExecuting: ${sql_query}`);

    try {
        const res = await dbClient.query(sql_query);
        const resultString = res.rows.length > 0 
            ? JSON.stringify(res.rows, null, 2)
            : "No data found matching the query.";

        return { db_result: resultString, error: null };
    } catch (err) {
        console.error(`\nDB Error: ${err.message}`);
        return { db_result: null, error: err.message };
    }
}

async function refineResponseNode(state) {
    const { current_question, sql_query, db_result } = state;
    
    console.log("\n✨ Formatting answer...");

    const prompt = `
        User asked: "${current_question}"
        SQL Used: "${sql_query}"
        Data Retrieved:
        ${db_result}

        Provide a natural language answer summarizing the data.
    `;

    const result = await llm.invoke(prompt);

    return { 
        messages: [
            new HumanMessage(current_question),
            new AIMessage(result.content)
        ],
        db_result: result.content,
        error: null,
        retry_count: 0 
    };
}

// --- 4. Logic & Router ---

function checkQueryStatus(state) {
    const { error, retry_count } = state;
    if (error) {
        if (retry_count < MAX_RETRIES) return "RETRY";
        return "FAIL";
    }
    return "SUCCESS";
}

// --- 5. Build Graph ---

function buildGraph() {
    const workflow = new StateGraph(GraphState) 
        .addNode("introspection", introspectionNode)
        .addNode("generateSql", generateSqlNode)
        .addNode("executeSql", executeSqlNode)
        .addNode("refineResponse", refineResponseNode);

    workflow.addEdge(START, "introspection");
    
    workflow.addConditionalEdges("introspection", 
        (state) => state.error ? "FAIL" : "CONTINUE", 
        { FAIL: END, CONTINUE: "generateSql" }
    );

    workflow.addEdge("generateSql", "executeSql");
    
    workflow.addConditionalEdges("executeSql", checkQueryStatus, {
        RETRY: "generateSql",
        SUCCESS: "refineResponse",
        FAIL: END
    });

    workflow.addEdge("refineResponse", END);

    return workflow.compile({ checkpointer: memory });
}

// --- 6. CLI Execution ---

async function main() {
    const rl = readline.createInterface({ input, output });

    console.log("\n👋 Universal SQL Agent (Multi-Turn)");
    const ask = async (q, d) => { const a = await rl.question(`${q} (${d}): `); return a.trim() || d; };
    
    try {
        const pgUser = await ask("PG User", "postgres");
        const pgHost = await ask("PG Host", "localhost");
        const pgDb = await ask("PG Database", "projectmanagment");
        const pgSchemaInput = await ask("PG Schema", "public"); // <-- Ask for Schema
        const pgPass = await ask("PG Password", "password123");
        const pgPort = await ask("PG Port", "5432");

        // Set the global schema variable
        targetSchema = pgSchemaInput;

        dbClient = new Client({ user: pgUser, host: pgHost, database: pgDb, password: pgPass, port: parseInt(pgPort) });
        await dbClient.connect();
        
        // IMPORTANT: Set search_path for this session.
        // This allows "SELECT * FROM users" to work even if users is inside "pm" schema.
        await dbClient.query(`SET search_path TO "${targetSchema}"`);
        
        console.log(`✅ Connected to DB (Schema: ${targetSchema}).`);

        const app = buildGraph();
        const config = { configurable: { thread_id: "session_1" } };

        console.log("\n🤖 Agent Ready! Ask questions (or type 'exit').");

        while (true) {
            const userInput = await rl.question('\n❓ You: ');
            if (userInput.toLowerCase() === 'exit') break;
            if (!userInput.trim()) continue;

            const inputs = { 
                current_question: userInput,
                retry_count: 0, 
                error: null
            };

            const finalState = await app.invoke(inputs, config);

            if (finalState.error) {
                console.log(`❌ Error: ${finalState.error}`);
            } else if (finalState.db_result) {
                console.log(`\n🤖 AI: ${finalState.db_result}`);
            }
        }

    } catch (e) {
        console.error("Critical Error:", e);
    } finally {
        if (dbClient) await dbClient.end();
        rl.close();
    }
}

main();