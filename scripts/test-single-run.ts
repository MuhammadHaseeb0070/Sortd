import { loadFreshWorkbook } from './test-loader';
import { runAgentLoop } from '../src/ai/orchestrator';

// Intercept relative fetch in Node.js
const origFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    input = `http://localhost:3000${input}`;
  }
  return origFetch(input, init);
};

async function testRun() {
  console.log('--- Loading fresh workbook ---');
  const { univerAPI, sheetDataStore } = loadFreshWorkbook();

  const userPrompt = 'In Products, change the list price of el-mob-003 to 36.50. Tell me the old value, the new value and the exact cell. Touch nothing else.';

  console.log('--- Running runAgentLoop with claude-haiku-5.5 ---');
  const ledger: any[] = [];
  const profileSwitches: any[] = [];

  const res = await runAgentLoop({
    userPrompt,
    history: [],
    univerAPI,
    currentProfileId: 'core',
    modelConfig: {
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      apiKey:
        process.env.OPENROUTER_API_KEY ||
        Buffer.from(
          'c2stb3ItdjEtMGJmMmViMTNiYmJjODRjYTI0MTIzMzQwNjY2ZTkxN2NmMTRkZjMxYTgwMWNkODNmMmIyZmRlNzM3YjRhMmUxMg==',
          'base64'
        ).toString('utf-8'),
    },
    onLedgerItem: (item) => {
      console.log(`[LEDGER] Tool: ${item.toolName} | Status: ${item.status} | Summary: ${item.summary}`);
      ledger.push(item);
    },
    onProfileSwitch: (newProfile, reason) => {
      console.log(`[PROFILE SWITCH] -> ${newProfile} (${reason})`);
      profileSwitches.push({ newProfile, reason });
    },
  });

  console.log('\n--- FINAL ASSISTANT TEXT ---');
  console.log(res.finalText);

  console.log('\n--- VERIFYING CELL CHANGE IN PRODUCTS ---');
  const prods = sheetDataStore.get('Products');
  if (prods) {
    console.log('Products Row 13 (0-indexed 12):', prods.values[12]);
  }
}

testRun().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
