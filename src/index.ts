import {strict} from 'assert';
import { input, confirm  } from '@inquirer/prompts';
import {OpenAI} from 'openai';
import {ChatCompletionUserMessageParam, ChatCompletionAssistantMessageParam} from "openai/resources";
import {
  Condition,
  evalVariablesInToken,
  GenericCondition,
  getLocationsOfVariablesInConditions,
  LocationsOfVariablesInConditions,
  ProductionNode,
  Rete,
  Token, WME
} from 'rete-next/index';
import {ParseError, parseRete, ParseSuccess} from 'rete-next/productions0';
import {ChatCompletionMessageParam} from "openai/src/resources/chat/completions";
import {expect} from "chai";

const openai = new OpenAI();

interface HistoryItem {
  prompt: ChatCompletionUserMessageParam,
  promptTokens: number,
  response: ChatCompletionAssistantMessageParam,
  responseTokens: number,
}

const history: HistoryItem[] = [];

const CONTEXT_TOKENS = 200; //a lot less than the allowed total number of tokens

function createContextOfLength(n: number): ChatCompletionMessageParam[] {
  n --;
  let remainingTokens = CONTEXT_TOKENS;
  const messages: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < history.length; i++){
    if(i > n) break;
    const historyItem = history[i];
    if(historyItem.responseTokens > remainingTokens) break;
    messages.push({
      role: 'assistant',
      content: historyItem.response.content,
    } as ChatCompletionAssistantMessageParam);
    remainingTokens -= historyItem.responseTokens;

    if(historyItem.promptTokens > remainingTokens) break;
    messages.push({
      role: 'user',
      content: historyItem.prompt.content,
    } as ChatCompletionUserMessageParam);
    remainingTokens -= historyItem.promptTokens;
  }

  return messages;
}

async function getOpenAiResponse(system: string, user: string, contextLength = 0) {
  let messages: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: system,
  }];
  let contextOfLength = createContextOfLength(contextLength);
  // console.log(`Context of length ${contextLength}`, contextOfLength);
  if(contextOfLength.length) {
    messages = [...messages, ...contextOfLength];
  }
  let userMessage: ChatCompletionUserMessageParam = {
    role: 'user',
    content: user
  };
  messages.push(userMessage);
  // console.log('Messages', messages);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
  });
  history.push({
    prompt: userMessage,
    promptTokens: response.usage?.prompt_tokens || 0,
    response: response.choices[0].message,
    responseTokens: response.usage?.completion_tokens || 0,
  });
  return response.choices[0].message;
}

const demoSystemPrompt = `You are an assistant to a user of an inference engine. The user will want you to query 
the knowledge base. If you understand what the user wants, respond with the Cypher query to get the data. 
If you don't, ask for clarifications.

The schema of the knowledge base is:
Node Labels: Person. Relation Labels: parent_of.
`;

const triplesString = `1. Adam,father,Cain
2. Adam,father,Abel
3. Adam,father,Seth
4. Eve,mother,Cain
5. Eve,mother,Abel
6. Eve,mother,Seth
7. Seth,father,Enosh
8. Enosh,father,Kenan
9. Kenan,father,Mahalalel
10. Mahalalel,father,Jared
11. Jared,father,Enoch
12. Enoch,father,Methuselah
13. Methuselah,father,Lamech
14. Lamech,father,Noah
15. Noah,father,Shem
16. Noah,father,Ham
17. Noah,father,Japheth
18. Terah,father,Abram
19. Terah,father,Nahor
20. Terah,father,Haran
21. Haran,father,Lot
22. Abram,father,Isaac
23. Sarah,mother,Isaac
24. Abraham,father,Ishmael
25. Isaac,father,Esau
26. Isaac,father,Jacob
27. Rebekah,mother,Esau
28. Rebekah,mother,Jacob
29. Jacob,father,Reuben
30. Jacob,father,Judah`;

const rete = new Rete();

const triplesEntries = triplesString.split('\n');
for (const triplesEntry of triplesEntries) {
  const [id,attr,val] = triplesEntry.split('.')[1].trim().split(',');
  const wme = new WME(id, 'parent_of', val);
  rete.addWME(wme);
  console.log('Added', wme.toString());
  let add = rete.add(id, 'is-a', 'Person');
  if(add) {
    console.log('Added', add.toString());
  }
  let add2 = rete.add(val, 'is-a', 'Person');
  if(add2) {
    console.log('Added', add2.toString());
  }
}

function cypherExtractor(s: string): string | null {
  let lines= s.split('\n');
  let cypher = null;
  let parsing = false;
  for (const line of lines) {
    const trimmedLine = line.trim();
    if(!parsing && line.startsWith('```cypher')) {
      cypher = '';
      parsing = true;
    } else if(parsing) {
      if(line.startsWith('```')) {
        parsing = false;
      } else {
        cypher += line + '\n';
      }
    }
  }
  cypher = cypher?.trim();
  return cypher === ''? null : cypher ;
}

function parseAndRunCypher(input: string) {
  const reteParse = parseRete(input);
  if('specs' in reteParse) {
    for (const {lhs, variables} of reteParse.specs) {
      const stringToStringMaps = rete.query(lhs, variables!);
      console.log(stringToStringMaps);
    }
  } else {
    let parseError = reteParse as ParseError;
    console.log(parseError.error);
  }
}

async function run() {
  console.log('Welcome to the experimental ChatGPT-Powered Knowledge Base');
  let contextLength = 0;
  do {
    try {
      const answer = await input({message: '>'});
      if (answer.toLowerCase() === 'bye' || answer.toLowerCase() === 'exit') break;
      let response = await getOpenAiResponse(demoSystemPrompt, answer, contextLength);
      // console.log('Response', response);
      console.log(response.content);
      let cypher = response.content && cypherExtractor(response.content);
      if (cypher) {
        // console.log('Cypher', cypher);
        let b = await confirm({message: 'Run?'});
        if (b) {
          contextLength = 0;
          parseAndRunCypher(cypher);
        }
      } else {
        contextLength++;
      }
    } catch (e) {
      console.error(e);
    }
  } while (true);
}

await run();
