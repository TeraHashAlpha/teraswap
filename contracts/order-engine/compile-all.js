#!/usr/bin/env node
/**
 * TeraSwap — Compile All Contracts
 *
 * Compiles both TeraSwapFeeCollector and TeraSwapOrderExecutor
 * using the correct solc version (0.8.24) via remote download.
 *
 * USAGE:
 *   node compile-all.js
 *
 * Output: build/ directory with ABI + bytecode for both contracts.
 */

import solc from "solc"
import fs from "fs"
import path from "path"

const basePath = decodeURIComponent(path.dirname(new URL(import.meta.url).pathname))
const contractsRoot = path.resolve(basePath, "..")

function findImports(importPath) {
  const nmPath = path.join(basePath, "node_modules", importPath)
  if (fs.existsSync(nmPath)) return { contents: fs.readFileSync(nmPath, "utf8") }

  const rootPath = path.join(contractsRoot, importPath)
  if (fs.existsSync(rootPath)) return { contents: fs.readFileSync(rootPath, "utf8") }

  const relPath = path.join(basePath, importPath)
  if (fs.existsSync(relPath)) return { contents: fs.readFileSync(relPath, "utf8") }

  return { error: `File not found: ${importPath}` }
}

async function compile(compiler) {
  console.log("⚙️  Compiling contracts (via-IR, optimizer 200)...\n")

  const executorSrc = fs.readFileSync(
    path.join(basePath, "TeraSwapOrderExecutor.sol"),
    "utf8"
  )
  const feeCollectorSrc = fs.readFileSync(
    path.join(contractsRoot, "TeraSwapFeeCollector.sol"),
    "utf8"
  )

  const input = {
    language: "Solidity",
    sources: {
      "TeraSwapOrderExecutor.sol": { content: executorSrc },
      "TeraSwapFeeCollector.sol": { content: feeCollectorSrc },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  }

  const output = JSON.parse(
    compiler.compile(JSON.stringify(input), { import: findImports })
  )

  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === "error")
    const warnings = output.errors.filter((e) => e.severity === "warning")

    if (warnings.length > 0) {
      console.log(`⚠️  ${warnings.length} warning(s):`)
      warnings.forEach((w) => console.log(`   ${w.formattedMessage.split("\n")[0]}`))
      console.log()
    }

    if (errors.length > 0) {
      console.error(`❌ ${errors.length} compilation error(s):`)
      errors.forEach((e) => console.error(e.formattedMessage))
      process.exit(1)
    }
  }

  // Save artifacts
  const buildDir = path.join(basePath, "build")
  fs.mkdirSync(buildDir, { recursive: true })

  const targets = ["TeraSwapOrderExecutor", "TeraSwapFeeCollector"]
  let compiled = 0

  for (const [fileName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, data] of Object.entries(contracts)) {
      const abiPath = path.join(buildDir, `${contractName}.abi.json`)
      const binPath = path.join(buildDir, `${contractName}.bin`)

      fs.writeFileSync(abiPath, JSON.stringify(data.abi, null, 2))
      if (data.evm?.bytecode?.object) {
        fs.writeFileSync(binPath, data.evm.bytecode.object)
        const sizeKB = (data.evm.bytecode.object.length / 2 / 1024).toFixed(1)
        console.log(`✅ ${contractName} → ${sizeKB} KB bytecode`)
        if (targets.includes(contractName)) compiled++
      }
    }
  }

  console.log(`\n🎉 Compilation complete! (${compiled}/${targets.length} target contracts)`)
  console.log(`📂 Artifacts: ${buildDir}`)
}

// Try to load the exact solc version, fall back to installed
async function main() {
  const installedVersion = solc.version()
  console.log(`Installed solc: ${installedVersion}`)

  // Contracts require 0.8.24 — check compatibility
  if (installedVersion.includes("0.8.24")) {
    console.log("✅ Version matches pragma, compiling directly...\n")
    await compile(solc)
  } else {
    console.log("⚠️  Version mismatch with pragma solidity 0.8.24")
    console.log("   Attempting to load solc 0.8.24 remotely...\n")

    try {
      const matchingCompiler = await new Promise((resolve, reject) => {
        solc.loadRemoteVersion("v0.8.24+commit.e11b9ed9", (err, snapshot) => {
          if (err) reject(err)
          else resolve(snapshot)
        })
      })
      console.log("✅ Loaded solc 0.8.24 remotely\n")
      await compile(matchingCompiler)
    } catch (err) {
      console.error("❌ Could not load solc 0.8.24:", err.message)
      console.error("\n   Options:")
      console.error("   1. Install matching version: npm install solc@0.8.24")
      console.error("   2. Update pragma to >=0.8.24 in .sol files")
      console.error("   3. Use hardhat: npx hardhat compile")
      process.exit(1)
    }
  }
}

main().catch((err) => {
  console.error("❌ Compilation failed:", err.message || err)
  process.exit(1)
})
