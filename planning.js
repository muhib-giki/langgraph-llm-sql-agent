import * as dotenv from "dotenv";
import { ChatGroq } from "@langchain/groq";
import { StateGraph, START, END } from "@langchain/langgraph";
import { PromptTemplate } from "@langchain/core/prompts";
import { Client } from "pg";
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// Load environment variables (Mainly for GROQ_API_KEY now)
dotenv.config();

// --- Configuration ---
const MAX_RETRIES = 3;

// We will store the DB client globally but initialize it after user input
let dbClient;

// --- 1. Define the Graph State ---
/*
  Added 'dynamic_schema_context' to hold the schema we learn from the DB.
*/
const InitialState = {
    question: "",
    sql_query: null,
    db_result: null,
    error: null,
    retry_count: 0,
    dynamic_schema_context: null // <--- New State Variable
};

// --- 2. Initialize Core Components ---
// We still need the API Key from env, or you could prompt for this too.
if (!process.env.GROQ_API_KEY) {
    console.error("❌ Error: GROQ_API_KEY is missing in .env file.");
    process.exit(1);
}

const llm = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama3-70b-8192",
    temperature: 0,
});

// --- 3. Define the Nodes ---

/**
 * Node 0 (NEW): Introspects the database to get table definitions.
 * This runs ONCE at the beginning.
 */
async function getIntrospectionNode(state) {
    console.log(`\n🔍 Introspecting database schema...`);
    
    // Query to get all tables and columns in the public schema
    // You can adjust 'public' to a variable if needed.
    const introspectionQuery = `
        SELECT table_name, column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        ORDER BY table_name, ordinal_position;
    `;

    try {
        const res = await dbClient.query(introspectionQuery);
        
        if (res.rows.length === 0) {
             return { error: "No tables found in 'public' schema. Cannot generate queries." };
        }

        // Format the result into a string that looks like CREATE TABLE statements for the LLM
        let schemaDescription = "Here is the database schema:\n";
        let currentTable = "";

        res.rows.forEach(row => {
            if (row.table_name !== currentTable) {
                currentTable = row.table_name;
                schemaDescription += `\nTable: ${currentTable}\nColumns:\n`;
            }
            schemaDescription += `- ${row.column_name} (${row.data_type})\n`;
        });

        console.log("✅ Schema loaded successfully.");
        return { dynamic_schema_context: schemaDescription };

    } catch (err) {
        return { error: `Introspection Failed: ${err.message}` };
    }
}

/**
 * Node 1: Generates or corrects the SQL query using the DYNAMIC schema.
 */
async function generateSqlNode(state) {
    const { question, error, retry_count, dynamic_schema_context } = state;
    
    // Safety check: if introspection failed, we can't proceed
    if (!dynamic_schema_context) {
        return { error: "Schema context is missing." };
    }

    console.log(`\n🤖 Attempt ${retry_count + 1}: Generating SQL query...`);

    const systemPrompt = `
        You are an expert PostgreSQL query translator. Your task is to convert a user's natural language question into a single, executable PostgreSQL SQL query.
        
        DATABASE SCHEMA CONTEXT:
        ---
        ${dynamic_schema_context}
        ---
        
        - Only return the SQL query. Do NOT include any markdown formatting or explanatory text.
        - IMPORTANT: If a previous ERROR is provided, analyze the error and correct your previous query to fix it.
        - Always use a LIMIT clause (e.g., LIMIT 10) unless the user asks for a specific count.
    `;

    const userPrompt = `
        User Question: "${question}"
        ${error ? `PREVIOUS ERROR: "${error}"\n--- CORRECT THE QUERY ABOVE ---` : ""}
        
        Generated SQL Query:
    `;

    const prompt = PromptTemplate.fromMessages([
        ["system", systemPrompt],
        ["user", userPrompt],
    ]);

    const chain = prompt.pipe(llm);
    const result = await chain.invoke({});
    const sqlQuery = result.content.trim().replace(/^```[a-z]*\n?|```$/gmi, '').trim().replace(/;$/, ''); 

    return {
        sql_query: sqlQuery,
        error: null,
        retry_count: retry_count + 1,
    };
}

/**
 * Node 2: Executes the SQL query.
 */
async function executeSqlNode(state) {
    const { sql_query } = state;

    if (!sql_query) return { error: "SQL Query was not generated." };

    console.log(`\nExecuting SQL: ${sql_query}`);

    try {
        const res = await dbClient.query(sql_query);
        const resultString = JSON.stringify(res.rows, null, 2);
        
        if (res.rows.length === 0) {
             return {
                db_result: null,
                error: `Query executed successfully but returned 0 rows. Please rewrite the query to find relevant data.`,
            };
        }

        return { db_result: resultString, error: null };
    } catch (err) {
        console.error(`\nDB Error: ${err.message}`);
        return { db_result: null, error: err.message };
    }
}

/**
 * Node 3: Refines the response.
 */
async function refineResponseNode(state) {
    const { question, sql_query, db_result } = state;
    
    if (!db_result || !sql_query) return { error: "Refine node called without query result." };

    console.log("\n✨ Formatting final response...");

    const prompt = PromptTemplate.fromMessages([
        ["system", "You are a helpful assistant. Take the user's original question and the structured database result, and combine them into a clear, natural language answer. Also, provide the SQL query used."],
        ["human", `Original Question: "${question}"\nSQL Query Executed: "${sql_query}"\nDatabase Result:\n${db_result}`],
    ]);

    const chain = prompt.pipe(llm);
    const result = await chain.invoke({});

    return { db_result: result.content, error: null };
}

// --- 4. Define the Router ---

function checkQueryStatus(state) {
    const { error, retry_count } = state;

    if (error) {
        if (retry_count < MAX_RETRIES) {
            console.log(`\n❌ Error detected. Retrying...`);
            return "RETRY";
        } else {
            console.log("\n💀 Retry limit reached. Failing the process.");
            return "FAIL";
        }
    } else {
        console.log("\n✅ Query successful. Moving to final response.");
        return "SUCCESS";
    }
}

// --- 5. Main Execution Flow ---

async function runAgent(question) {
    const workflow = new StateGraph()
        .addNode("getIntrospection", getIntrospectionNode) // New Node
        .addNode("generateSql", generateSqlNode)
        .addNode("executeSql", executeSqlNode)
        .addNode("refineResponse", refineResponseNode);

    // 1. Start -> Introspection (Get Schema first)
    workflow.addEdge(START, "getIntrospection");

    // 2. Introspection -> generateSql (Pass schema to LLM)
    // We add a simple check here: if introspection fails, go to END
    workflow.addConditionalEdges("getIntrospection", (state) => state.error ? "FAIL_INTRO" : "CONTINUE", {
        FAIL_INTRO: END,
        CONTINUE: "generateSql"
    });

    // 3. generateSql -> executeSql
    workflow.addEdge("generateSql", "executeSql");
    
    // 4. Conditional Branching from executeSql
    workflow.addConditionalEdges("executeSql", checkQueryStatus, {
        RETRY: "generateSql",     
        SUCCESS: "refineResponse", 
        FAIL: END,                 
    });

    workflow.addEdge("refineResponse", END);

    const app = workflow.compile();

    // Prepare initial state
    const stateInput = {
        ...InitialState,
        question: question
    };

    console.log(`\n--- Starting SQL Agent for: "${question}" ---`);
    const finalState = await app.invoke(stateInput);
    console.log("\n--- Agent Run Complete ---");

    if (finalState.db_result && !finalState.error) {
        console.log("\n**Final Answer:**");
        console.log(finalState.db_result); 
    } else {
        console.log("\n**Agent Failed.**");
        console.log(`Last Error: ${finalState.error}`);
    }
}

// --- 6. Interactive CLI & Setup ---

async function main() {
    const rl = readline.createInterface({ input, output });

    console.log("\n👋 Welcome to the Universal SQL Agent!");
    console.log("Please provide your PostgreSQL Connection Details.\n");

    // Helper to get input with default value
    const ask = async (query, defaultVal) => {
        const answer = await rl.question(`${query} (${defaultVal}): `);
        return answer.trim() || defaultVal;
    };

    try {
        const pgUser = await ask("PG User", "postgres");
        const pgHost = await ask("PG Host", "localhost");
        const pgDb = await ask("PG Database", "projectmanagment");
        const pgPass = await ask("PG Password", "password123");
        const pgPort = await ask("PG Port", "5432");

        // Initialize Client with User Inputs
        dbClient = new Client({
            user: pgUser,
            host: pgHost,
            database: pgDb,
            password: pgPass,
            port: parseInt(pgPort),
        });

        console.log("\n🔌 Connecting to database...");
        await dbClient.connect();
        console.log("✅ Connected!");

        // Loop for questions
        while (true) {
            const question = await rl.question('\n❓ Ask your question in plain English (or type "exit"): ');
            
            if (question.toLowerCase() === 'exit') {
                break;
            }

            if (question.trim()) {
                await runAgent(question).catch(console.error);
            }
        }

    } catch (error) {
        console.error("\n❌ Connection Failed or Error Occurred:", error.message);
    } finally {
        if (dbClient) await dbClient.end();
        rl.close();
        console.log("\nGoodbye! 👋");
    }
}

main();