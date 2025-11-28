import readline from 'node:readline/promises';
import { Client } from "pg";

let dbClient;
/**
 * connect to a pgsql database
 * ask to user to write in plain english to generate a query on the connected db
 * see if the result is generated, if there is an error, retry to fix and continue the process
 * 
 * 
 * 
 * 
 */

// 1. 


async function getDbConnectionDetails() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const ask = async (question, defaultValue) => {
        const answer = await rl.question(`Enter ${question} (${defaultValue}): `);
        return answer.trim() || defaultValue;
    }

    try {
        const PG_USER = await ask("PG_USER: ", "postgres");
        const PG_HOST = await ask("PG_HOST: ", "localhost");
        const PG_DATABASE = await ask("PG_DATABASE: ", "postgres");
        const PG_SCHEMA = await ask("PG_SCHEMA: ", "public");
        const PG_PASSWORD = await ask("PG_PASSWORD: ", "password123");
        const PG_PORT = await ask("PG_PORT: ", "5432");
    
        console.log(PG_USER);
        console.log(PG_HOST);
        console.log(PG_DATABASE);
        console.log(PG_SCHEMA);
        console.log(PG_PASSWORD);
        console.log(PG_PORT);
    
        // Initialize Client with User Inputs
        dbClient = new Client({
            user: PG_USER,
            host: PG_HOST,
            database: PG_DATABASE,
            password: PG_PASSWORD,
            port: parseInt(PG_PORT),
            options: `-c search_path=${PG_SCHEMA}`,
        })
    
        console.log("\n🔌 Connecting to database...");
        await dbClient.connect();
        console.log("✅ Connected!");
    }
    catch (error) {
        console.log("Error while connecting to the database", error.message);
    } 
    finally {
        if (dbClient) await dbClient.end();
        rl.close();
        console.log("\nGoodbye");
    }

}

getDbConnectionDetails();