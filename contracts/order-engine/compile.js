import solc from 'solc';
import fs from 'fs';
import path from 'path';

const basePath = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname));

function findImports(importPath) {
  // Try node_modules first
  const nmPath = path.join(basePath, 'node_modules', importPath);
  if (fs.existsSync(nmPath)) {
    return { contents: fs.readFileSync(nmPath, 'utf8') };
  }
  // Try relative
  const relPath = path.join(basePath, importPath);
  if (fs.existsSync(relPath)) {
    return { contents: fs.readFileSync(relPath, 'utf8') };
  }
  return { error: `File not found: ${importPath}` };
}

const source = fs.readFileSync(path.join(basePath, 'TeraSwapOrderExecutor.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'TeraSwapOrderExecutor.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
  },
};

console.log('Compiling with via-IR pipeline...');
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  const warnings = output.errors.filter(e => e.severity === 'warning');

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`  - ${w.formattedMessage.split('\n')[0]}`));
  }

  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} error(s):`);
    errors.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
}

// Save artifacts
const buildDir = path.join(basePath, 'build');
fs.mkdirSync(buildDir, { recursive: true });

for (const [fileName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, contractData] of Object.entries(contracts)) {
    const abiPath = path.join(buildDir, `${contractName}.abi.json`);
    const binPath = path.join(buildDir, `${contractName}.bin`);

    fs.writeFileSync(abiPath, JSON.stringify(contractData.abi, null, 2));
    if (contractData.evm?.bytecode?.object) {
      fs.writeFileSync(binPath, contractData.evm.bytecode.object);
    }
    console.log(`✅ ${contractName} → ${abiPath}`);
  }
}

console.log('\n🎉 Compilation successful!');
