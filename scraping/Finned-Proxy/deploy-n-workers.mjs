//deploy-n-workers.mjs

import fs from 'fs'; //file system operations
import path from 'path'; //path operations
import { randomBytes } from 'crypto';
import { Blob } from 'node:buffer'; 

//import config
const configPath = path.resolve(process.cwd(), 'config.json'); //path.resolve resolves a sequence of paths or path segments into an absolute path.
//error handling if the config file does not exist
if (!fs.existsSync(configPath)) {
    console.error('config.json file not found. Please create it with your configuration.');
    process.exit(1);
}
//import the config file
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')); //read the config file and parse it as JSON
//error handling if the config file does not contain num_workers
if (!config.num_workers) {
    console.error('config.json must contain num_workers.');
    process.exit(1);
}
const num_workers = config.num_workers; //number of workers to deploy

//import account and api
const secretsPath = path.resolve(process.cwd(), 'secrets.json'); //path.resolve resolves a sequence of paths or path segments into an absolute path. 
                                                                 //this is useful for ensuring that the path to the secrets file is correct regardless of the current working directory.
//error handling if the secrets file does not exist
if (!fs.existsSync(secretsPath)) {
    console.error('secrets.json file not found. Please create it with your API key.');
    process.exit(1);
}
//import the secrets file
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); //read the secrets file and parse it as JSON
const { accountId, apiToken } = secrets; //destructure the accountId and apiToken from the secrets object
//error handling if the secrets file does not contain accountId or apiToken
if (!accountId || !apiToken) {
    console.error('secrets.json must contain accountId and apiToken.');
    process.exit(1);
}

const scriptSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.js'), 'utf8'); //read the index.js file and store it in a variable

// Check if worker-proxies.json exists and is valid
const proxiesPath = path.resolve(process.cwd(), 'worker-proxies.json');
let proxiesJson; //initialize the proxiesJson variable

// If file doesn’t exist, initialize it
if (!fs.existsSync(proxiesPath)) {
  proxiesJson = { workers: [] };
  fs.writeFileSync(proxiesPath, JSON.stringify(proxiesJson, null, 2), 'utf8');
} else {
  // Otherwise parse the existing one
  try {
    const raw = fs.readFileSync(proxiesPath, 'utf8');
    proxiesJson = JSON.parse(raw);
    if (!Array.isArray(proxiesJson.workers)) {
      throw new Error('top-level “workers” is not an array');
    }
  } catch (err) {
    console.error('Failed to parse or validate worker-proxies.json:', err.message);
    process.exit(1);
  }
}

//find existing entry by worker name
function findEntryByName(name) {
    return proxiesJson.workers.find((entry) => entry.name === name) || null; //find the entry by name or return null if not found
}

//deploy a single worker
async function deployOneWorker(workerName, apiKey) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`; //how does cloudflare urls work?

    // Build multipart/form-data:
    //  - metadata: { body_part: "script", vars: { API_KEY: "<apiKey>" } }
    //  - script:   the actual JS source
    const form = new FormData(); //create a new FormData object
    const metadata = {
        body_part: 'script',
        bindings: [ //cloudflare expect bindings]
            { type: 'plain_text', name: 'API_KEY', text: apiKey },
        ],
    };
    form.append(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
        'metadata.json'
    );
    form.append(
        'script',
        new Blob([scriptSource], { type: 'application/javascript' }),
        'index.js'
    );

    const response = await fetch(url, {
        method: 'PUT',
        headers: {'Authorization': `Bearer ${apiToken}`},
        body: form, //the body of the request is the form-data
    });

    const json = await response.json(); //parse the response as JSON
    if (!json.success) {
        console.error(`[${workerName}] deploy failed:`, JSON.stringify(json.errors || json, null, 2)); //JSON.stringify converts a JavaScript object or value to a JSON string
        return false;
    } else {
        console.log(`deployed worker [${workerName}] successfully`);
        return true;
    }
}

//loop to deploy n workers
(async () => {
    for (let i = 1; i <= num_workers; i++){
        const workerName = `finned-proxy-${i}`; //name of the worker
        let entry = findEntryByName(workerName); //find the entry by name
        let apiKey;
        if (entry) {
            apiKey = entry.apiKey; //if the entry exists, get the apiKey from the entry
        } else {
            //generate a new 16-byte hexadecimal API key
            apiKey = randomBytes(16).toString('hex'); //generate a random API key
            console.log(`generated new API key for worker [${workerName}]: ${apiKey}`); //log the generated API key
        }

        //deploy the worker with the API key
        const success = await deployOneWorker(workerName, apiKey); //deploy the worker with the API key
        if (!success) {
            console.error(`Failed to deploy worker [${workerName}].`); //log an error if the deployment failed
            continue; //skip to the next iteration
        }

        const publicUrl = `https://${workerName}.mac-48b.workers.dev/`;
        if (!entry) {
            //if the entry does not exist, create a new one
            proxiesJson.workers.push({
                name: workerName,
                apiKey: apiKey,
                publicUrl: publicUrl,
            });
        } else {
            //if the entry exists, update the publicUrl
            entry.publicUrl = publicUrl;
        }
    }
    //write the updated worker-proxies.json file
    fs.writeFileSync(proxiesPath, JSON.stringify(proxiesJson, null, 2), 'utf8');
    console.log(`Updated worker-proxies.json with ${num_workers} workers.`);
})();
