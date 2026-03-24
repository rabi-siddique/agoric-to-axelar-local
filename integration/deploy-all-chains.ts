#!/usr/bin/env vite-node

import { spawn } from "child_process";
import * as path from "path";
import { ethers } from "ethers";
import { config } from "dotenv";
import {
  ChainConfig,
  MAINNET_CHAINS,
  TESTNET_CHAINS,
  CHAIN_ALIASES,
} from "./chain-config.js";

config();

const { PRIVATE_KEY } = process.env;

interface ChainNonceInfo {
  chain: string;
  chainId: number;
  nonce: number;
  provider: ethers.JsonRpcProvider;
}

const getNonceForChain = async (
  chainConfig: ChainConfig,
  wallet: ethers.Wallet,
): Promise<ChainNonceInfo> => {
  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const connectedWallet = wallet.connect(provider);
    const nonce = await provider.getTransactionCount(
      await connectedWallet.getAddress(),
    );

    return {
      chain: chainConfig.name,
      chainId: chainConfig.chainId,
      nonce,
      provider,
    };
  } catch (error) {
    console.error(`Error fetching nonce for ${chainConfig.name}:`, error);
    throw error;
  }
};

const CHAINS = {
  mainnet: ["arb", "avax", "base", "eth", "opt"],
  testnet: [
    "arb-sepolia",
    "base-sepolia",
    "eth-sepolia",
    "fuji",
    "opt-sepolia",
  ],
};

const ALL_CHAINS = [...CHAINS.mainnet, ...CHAINS.testnet];
export type ContractType =
  | "factory"
  | "depositFactory"
  | "remoteAccountFactory"
  | "portfolioRouter";
interface DeployOptions {
  chains?: string[]; // Specific chains to deploy to
  contract: ContractType; // Contract type
  ownerType?: "ymax0" | "ymax1"; // Owner type (for depositFactory)
  parallel?: boolean; // Run deployments in parallel
  continueOnError?: boolean; // Continue even if one deployment fails
}

interface DeployResult {
  chain: string;
  success: boolean;
  output?: string;
  error?: string;
}

const getChainConfigs = (chains: string[]): ChainConfig[] => {
  const isTestnet = chains.some((c) => CHAINS.testnet.includes(c));
  const allChainConfigs = isTestnet ? TESTNET_CHAINS : MAINNET_CHAINS;

  return allChainConfigs.filter((config) => {
    const chainNameLower = config.name.toLowerCase();
    return chains.some((selected) => {
      const selectedLower = selected.toLowerCase();
      // Check if it's an alias
      const aliasMatch = CHAIN_ALIASES[selectedLower];
      if (aliasMatch && chainNameLower === aliasMatch) {
        return true;
      }
      // Direct substring match
      return (
        chainNameLower.includes(selectedLower) ||
        selectedLower.includes(chainNameLower)
      );
    });
  });
};

const checkAndSyncNonces = async (
  chains: string[],
): Promise<{ success: boolean; synced: boolean }> => {
  if (!PRIVATE_KEY) {
    console.log(
      "\n⚠️  PRIVATE_KEY not set, skipping nonce synchronization check\n",
    );
    return { success: true, synced: false };
  }

  console.log("\n🔍 Checking nonces across selected chains...\n");

  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const address = await wallet.getAddress();
  console.log(`   Wallet address: ${address}`);

  const chainConfigs = getChainConfigs(chains);

  if (chainConfigs.length === 0) {
    console.log("   ⚠️  Could not map chain names to configurations\n");
    return { success: true, synced: false };
  }

  // Fetch nonces from all selected chains
  const nonceInfos: ChainNonceInfo[] = [];
  for (const config of chainConfigs) {
    try {
      const info = await getNonceForChain(config, wallet);
      nonceInfos.push(info);
      console.log(`   ${info.chain.padEnd(15)}: Nonce ${info.nonce}`);
    } catch (error) {
      console.error(`   ❌ Failed to fetch nonce for ${config.name}`);
    }
  }

  if (nonceInfos.length === 0) {
    console.log("   ⚠️  Could not fetch any nonces\n");
    return { success: true, synced: false };
  }

  // Check if all nonces are the same
  const nonces = nonceInfos.map((info) => info.nonce);
  const allSame = nonces.every((n) => n === nonces[0]);

  if (allSame) {
    console.log(
      `\n✅ All chains have the same nonce (${nonces[0]}), no sync needed\n`,
    );
    return { success: true, synced: false };
  }

  // Nonces differ, need to sync
  const maxNonce = Math.max(...nonces);
  const minNonce = Math.min(...nonces);
  const targetNonce = maxNonce; // Sync all chains to the highest nonce

  console.log(
    `\n⚠️  Nonces differ across chains (min: ${minNonce}, max: ${maxNonce})`,
  );
  console.log(`🎯 Target nonce: ${targetNonce}`);
  console.log("   Running nonce synchronization...\n");

  // Run the increment-nonce.ts script with target nonce
  const isTestnet = chains.some((c) => CHAINS.testnet.includes(c));
  const scriptPath = path.resolve(
    __dirname,
    "../packages/axelar-local-dev-cosmos/scripts/increment-nonce.ts",
  );

  const args = [
    "--chains",
    chains.join(","),
    "--target-nonce",
    targetNonce.toString(),
  ];
  if (isTestnet) {
    args.push("--testnet");
  }

  return new Promise((resolve) => {
    const child = spawn("npx", ["ts-node", scriptPath, ...args], {
      cwd: path.resolve(__dirname, "../packages/axelar-local-dev-cosmos"),
      stdio: "inherit",
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        console.log("\n✅ Nonce synchronization complete\n");
        resolve({ success: true, synced: true });
      } else {
        console.error(
          `\n❌ Nonce synchronization failed (exit code: ${code})\n`,
        );
        resolve({ success: false, synced: true });
      }
    });

    child.on("error", (error) => {
      console.error(`\n❌ Failed to run nonce sync: ${error.message}\n`);
      resolve({ success: false, synced: true });
    });
  });
};

/**
 * Deploy contracts to a specific chain
 */
const deployToChain = async (
  chain: string,
  contract: string,
  ownerType?: string,
): Promise<DeployResult> => {
  const scriptPath = path.resolve(
    __dirname,
    "../packages/axelar-local-dev-cosmos/scripts/deploy.sh",
  );

  const args = [chain, contract, ownerType].filter(Boolean) as string[];

  console.log(`\n🚀 Deploying ${contract} to ${chain}...`);

  return new Promise((resolve) => {
    // Use 'yes' command to auto-confirm all prompts
    const yesProcess = spawn("yes", ["y"], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    const child = spawn(scriptPath, args, {
      cwd: path.resolve(__dirname, "../packages/axelar-local-dev-cosmos"),
      env: { ...process.env },
      stdio: [yesProcess.stdout, "inherit", "inherit"],
    });

    child.on("close", (code: number | null) => {
      yesProcess.kill();
      if (code === 0) {
        console.log(`\n✅ Successfully deployed to ${chain}`);
        resolve({
          chain,
          success: true,
        });
      } else {
        console.error(`\n❌ Failed to deploy to ${chain} (exit code: ${code})`);
        resolve({
          chain,
          success: false,
          error: `Deployment failed with exit code ${code}`,
        });
      }
    });

    child.on("error", (error) => {
      yesProcess.kill(); // Kill the yes process
      console.error(`\n❌ Failed to deploy to ${chain}`);
      console.error(`   Error: ${error.message}`);
      resolve({
        chain,
        success: false,
        error: error.message,
      });
    });
  });
};

/**
 * Deploy contracts to multiple chains
 */
const deployToAllChains = async (
  options: DeployOptions,
): Promise<DeployResult[]> => {
  const {
    chains = ALL_CHAINS,
    contract,
    ownerType,
    parallel = false,
    continueOnError = true,
  } = options;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("🌐 Multi-Chain Deployment Script");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Contract Type: ${contract}`);
  if (ownerType) {
    console.log(`Owner Type: ${ownerType}`);
  }
  console.log(`Chains: ${chains.join(", ")}`);
  console.log(`Mode: ${parallel ? "Parallel" : "Sequential"}`);
  console.log(`Continue on Error: ${continueOnError}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Sync nonces before deployment (skip for CREATE2-deployed contracts)
  if (contract === "remoteAccountFactory") {
    console.log(
      "ℹ️  Skipping nonce sync for remoteAccountFactory (uses CREATE2)\n",
    );
  } else {
    const syncResult = await checkAndSyncNonces(chains);
    if (!syncResult.success) {
      console.error("❌ Nonce sync failed, aborting deployment.\n");
      process.exit(1);
    }

    // Wait for nonce sync transactions to get enough confirmations
    // Hardhat Ignition requires at least 5 confirmations before deploying
    if (syncResult.synced) {
      console.log(
        "⏳ Waiting 60 seconds for nonce sync transactions to confirm...\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 60000));
      console.log("✅ Ready to deploy\n");
    }
  }

  const results: DeployResult[] = [];

  if (parallel) {
    // Deploy to all chains in parallel
    const promises = chains.map((chain) =>
      deployToChain(chain, contract, ownerType),
    );
    const allResults = await Promise.allSettled(promises);

    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i];
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          chain: chains[i],
          success: false,
          error: result.reason?.message || "Unknown error",
        });
      }
    }
  } else {
    // Deploy to chains sequentially
    // Always deploy to eth first, then others
    // Rationale: ETH deployments can fail due to gas spikes. Better to attempt ETH first.
    // If it fails, we can sync nonces on other chains for the same address before retrying.
    const sortedChains = [...chains].sort((a, b) => {
      if (a === "eth") return -1;
      if (b === "eth") return 1;
      return 0;
    });

    for (const chain of sortedChains) {
      const result = await deployToChain(chain, contract, ownerType);
      results.push(result);

      if (!result.success) {
        console.error(
          "\n❌ Deployment failed. Stopping sequential deployment.",
        );
        break;
      }
    }
  }

  return results;
};

const printSummary = (results: DeployResult[]) => {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("📊 Deployment Summary");
  console.log("═══════════════════════════════════════════════════════════");

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`\n✅ Successful: ${successful.length}`);
  for (const r of successful) {
    console.log(`   - ${r.chain}`);
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}`);
    for (const r of failed) {
      console.log(`   - ${r.chain}: ${r.error}`);
    }
  }

  console.log(`\n📈 Total: ${results.length} deployments`);
  console.log(
    `   Success Rate: ${((successful.length / results.length) * 100).toFixed(1)}%`,
  );
  console.log("═══════════════════════════════════════════════════════════\n");
};

const parseArgs = (): DeployOptions => {
  const args = process.argv.slice(2);
  const options: DeployOptions = {
    contract: "factory",
    parallel: false,
    continueOnError: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--contract":
      case "-c":
        const contractType = args[++i];
        const contractTypes = [
          "factory",
          "depositFactory",
          "remoteAccountFactory",
          "portfolioRouter",
        ];

        if (!contractTypes.includes(contractType)) {
          throw new Error(
            `Contract must be one of: ${JSON.stringify(contractTypes)}`,
          );
        }
        options.contract = contractType as ContractType;
        break;

      case "--owner-type":
      case "-o":
        const ownerType = args[++i];
        if (ownerType !== "ymax0" && ownerType !== "ymax1") {
          throw new Error('Owner type must be either "ymax0" or "ymax1"');
        }
        options.ownerType = ownerType;
        break;

      case "--chains":
        const chainList = args[++i];
        options.chains = chainList.split(",").map((c) => c.trim());
        break;

      case "--mainnet":
        options.chains = CHAINS.mainnet;
        break;

      case "--testnet":
        options.chains = CHAINS.testnet;
        break;

      case "--parallel":
      case "-p":
        options.parallel = true;
        break;

      case "--sequential":
      case "-s":
        options.parallel = false;
        break;

      case "--stop-on-error":
        options.continueOnError = false;
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
};

const printHelp = () => {
  console.log(`
🌐 Multi-Chain Deployment Script

Usage: ts-node deploy-all-chains.ts [options]

Options:
  -c, --contract <type>        Contract type: "factory", "depositFactory", "remoteAccountFactory", or "portfolioRouter" (default: factory)
  -o, --owner-type <type>      Owner type: "ymax0" or "ymax1" (for depositFactory and remoteAccountFactory)
  --chains <chain1,chain2>     Comma-separated list of specific chains to deploy to
  --mainnet                    Deploy to all mainnet chains only
  --testnet                    Deploy to all testnet chains only
  -p, --parallel               Run deployments in parallel (faster but less verbose)
  -s, --sequential             Run deployments sequentially (default)
  --stop-on-error              Stop deployment if any chain fails (default: continue)
  -h, --help                   Show this help message

Supported Chains:
  Mainnet: ${CHAINS.mainnet.join(", ")}
  Testnet: ${CHAINS.testnet.join(", ")}

Note: Nonces are automatically checked and synchronized if they differ across chains.

Environment Variables (for remoteAccountFactory):
  VETTING_AUTHORITY            Required: Address authorized to vet new routers

Environment Variables (for portfolioRouter):
  REMOTE_ACCOUNT_FACTORY       Required: Address of the deployed RemoteAccountFactory contract

Examples:
  # Deploy factory to all chains sequentially
  yarn deploy:all

  # Deploy depositFactory to all mainnet chains in parallel
  yarn deploy:all --contract depositFactory --owner-type ymax0 --mainnet --parallel

  # Deploy to specific chains
  yarn deploy:all --chains eth,base,opt

  # Deploy to testnets only
  yarn deploy:all --testnet --sequential

  # Deploy depositFactory with ymax1 owner to all chains, stop on first error
  yarn deploy:all -c depositFactory -o ymax1 --stop-on-error

  # Deploy remoteAccountFactory to testnets
  VETTING_AUTHORITY=0x... yarn deploy:all -c remoteAccountFactory --testnet

  # Deploy RemoteAccountAxelarRouter
  REMOTE_ACCOUNT_FACTORY=0x... yarn deploy:all -c portfolioRouter --testnet
`);
};

const main = async () => {
  try {
    const options = parseArgs();
    const results = await deployToAllChains(options);
    printSummary(results);

    const hasFailures = results.some((r) => !r.success);
    process.exit(hasFailures ? 1 : 0);
  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  }
};

main();
