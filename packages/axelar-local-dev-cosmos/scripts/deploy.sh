#!/bin/bash

set -euo pipefail

YMAX0_MAINNET="agoric1wl2529tfdlfvure7mw6zteam02prgaz88p0jru4tlzuxdawrdyys6jlmnq"
YMAX1_MAINNET="agoric13ecz27mm2ug5kv96jyal2k6z8874mxzs4m4yuet36s4nqdl0ey6qr09p74"

YMAX0_TESTNET="agoric18ek5td2h397cmejnlndes50k84ywx82kau7aff80t74fcxmjnzqstjclj0"
YMAX1_TESTNET="agoric1ps63986jnululzkmg7h3nhs5at6vkatcgsjy9ttgztykuaepwpxsrw2sus"

# Get the directory of the script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/network-config.sh"

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <network> <contract> [owner_type]"
    echo ""
    echo "Arguments:"
    echo "  network        - Target network to deploy to"
    echo "  contract       - 'factory', 'depositFactory', 'remoteAccountFactory', or 'portfolioRouter'"
    echo "  owner_type     - Optional: 'ymax0' or 'ymax1' (default: ymax0)"
    echo "                   Used for remoteAccountFactory and depositFactory"
    echo ""
    echo "Supported networks:"
    echo "  Mainnets: arb, avax, base, eth, opt"
    echo "  Testnets: arb-sepolia, base-sepolia, eth-sepolia, fuji, opt-sepolia"
    echo ""
    echo "Examples:"
    echo "  $0 eth-sepolia factory               # Deploy Factory"
    echo "  $0 eth-sepolia depositFactory        # Deploy DepositFactory with ymax0 owner"
    echo "  $0 eth-sepolia depositFactory ymax1  # Deploy DepositFactory with ymax1 owner"
    echo ""
    echo "  # Deploy RemoteAccount (implementation) and RemoteAccountFactory (requires env vars):"
    echo "  VETTING_AUTHORITY=0x... $0 eth-sepolia remoteAccountFactory       # Deploy with ymax0 principal"
    echo "  VETTING_AUTHORITY=0x... $0 eth-sepolia remoteAccountFactory ymax1 # Deploy with ymax1 principal"
    echo ""
    echo "  # Deploy RemoteAccountAxelarRouter (requires env vars):"
    echo "  REMOTE_ACCOUNT_FACTORY=0x... $0 eth-sepolia portfolioRouter"
    echo ""
    echo "Environment Variables:"
    echo "  REMOTE_ACCOUNT_FACTORY - Required for portfolioRouter: previously deployed factory address"
    echo "  VETTING_AUTHORITY      - Required for remoteAccountFactory: address that can vet new routers"
    exit 0
fi

network=$1
contract=$2
owner_type=${3:-ymax0}

delete_deployments_folder() {
    local folder=$1
    if [ -d "$folder" ]; then
        echo "Deleting existing deployment folder: $folder"
        rm -rf "$folder"
    else
        echo "No existing deployment folder to delete: $folder"
    fi
}

get_network_config "$network"
delete_deployments_folder "ignition/deployments"

# Deploy based on contract type
case "$contract" in
    factory)
        echo ""
        echo "========================================="
        echo "Deploying Factory (simple wallet factory)..."
        echo "========================================="
        GATEWAY_CONTRACT="$GATEWAY" \
            GAS_SERVICE_CONTRACT="$GAS_SERVICE" \
            npx hardhat ignition deploy "./ignition/modules/deployFactory.ts" --network "$network" --verify
        ;;

    depositFactory)
        if [ -z "$FACTORY" ]; then
            echo "Error: FACTORY environment variable is not set"
            echo "Please set FACTORY=0x... before deploying DepositFactory"
            echo "Example: FACTORY=0x1234...abcd npm run deploy eth-sepolia depositFactory"
            exit 1
        fi

        # Validate owner type for DepositFactory
        if [[ "$owner_type" != "ymax0" && "$owner_type" != "ymax1" ]]; then
            echo "Error: Invalid owner type '$owner_type'"
            echo "Valid options: 'ymax0' or 'ymax1'"
            exit 1
        fi

        # Set owner address based on network type and owner type
        case "$network" in
            arb|avax|base|eth|opt)
                # Mainnet
                PRINCIPAL_CAIP2="cosmos:agoric-3"
                case "$owner_type" in
                    ymax0) PRINCIPAL_ACCOUNT="$YMAX0_MAINNET" ;;
                    ymax1) PRINCIPAL_ACCOUNT="$YMAX1_MAINNET" ;;
                esac
                ;;
            *)
                # Testnet
                PRINCIPAL_CAIP2="cosmos:agoricdev-25"
                case "$owner_type" in
                    ymax0) PRINCIPAL_ACCOUNT="$YMAX0_TESTNET" ;;
                    ymax1) PRINCIPAL_ACCOUNT="$YMAX1_TESTNET" ;;
                esac
                ;;
        esac

        echo ""
        echo "========================================="
        echo "Deploying DepositFactory (with Permit2 support)..."
        echo "========================================="
        echo "Using owner type: $owner_type"
        echo "Using Principal CAIP2: $PRINCIPAL_CAIP2"
        echo "Using Principal Account: $PRINCIPAL_ACCOUNT"

        GATEWAY_CONTRACT="$GATEWAY" \
            GAS_SERVICE_CONTRACT="$GAS_SERVICE" \
            PERMIT2_CONTRACT="$PERMIT2" \
            FACTORY_CONTRACT="$FACTORY" \
            OWNER_ADDRESS="$PRINCIPAL_ACCOUNT" \
            npx hardhat ignition deploy "./ignition/modules/deployDepositFactory.ts" --network "$network" --verify
        ;;

    remoteAccountFactory)
        # Validate owner type for RemoteAccountFactory
        if [[ "$owner_type" != "ymax0" && "$owner_type" != "ymax1" ]]; then
            echo "Error: Invalid owner type '$owner_type'"
            echo "Valid options: 'ymax0' or 'ymax1'"
            exit 1
        fi

        # Set PRINCIPAL_CAIP2 based on network type
        case "$network" in
            arb|avax|base|eth|opt)
            # Mainnet
            PRINCIPAL_CAIP2="cosmos:agoric-3"
            case "$owner_type" in
                ymax0) PRINCIPAL_ACCOUNT="$YMAX0_MAINNET" ;;
                ymax1) PRINCIPAL_ACCOUNT="$YMAX1_MAINNET" ;;
            esac
            ;;
        *)
            # Testnet
            PRINCIPAL_CAIP2="cosmos:agoricdev-25"
            case "$owner_type" in
                ymax0) PRINCIPAL_ACCOUNT="$YMAX0_TESTNET" ;;
                ymax1) PRINCIPAL_ACCOUNT="$YMAX1_TESTNET" ;;
            esac
            ;;
        esac

        echo ""
        echo "========================================="
        echo "Deploying RemoteAccount and RemoteAccountFactory..."
        echo "========================================="
        echo "Using owner type: $owner_type"
        echo "Using Principal CAIP2: $PRINCIPAL_CAIP2"
        echo "Using Principal Account: $PRINCIPAL_ACCOUNT"
        echo "Using Vetting Authority: $VETTING_AUTHORITY"
        PRINCIPAL_CAIP2="$PRINCIPAL_CAIP2" \
            PRINCIPAL_ACCOUNT="$PRINCIPAL_ACCOUNT" \
            VETTING_AUTHORITY="$VETTING_AUTHORITY" \
            npx hardhat ignition deploy "./ignition/modules/deployRemoteAccountFactory.ts" --network "$network" --strategy create2 --verify
        ;;

    portfolioRouter)
        # Axelar source chain can vary by $network, but all mainnet and testnet
        # networks currently share the same value.
        AXELAR_SOURCE_CHAIN="agoric"

        echo ""
        echo "========================================="
        echo "Deploying RemoteAccountAxelarRouter..."
        echo "========================================="
        echo "Using RemoteAccountFactory: $REMOTE_ACCOUNT_FACTORY"
        echo "Using Axelar Source Chain: $AXELAR_SOURCE_CHAIN"

        GATEWAY_CONTRACT="$GATEWAY" \
            AXELAR_SOURCE_CHAIN="$AXELAR_SOURCE_CHAIN" \
            FACTORY_CONTRACT="$REMOTE_ACCOUNT_FACTORY" \
            PERMIT2_CONTRACT="$PERMIT2" \
            npx hardhat ignition deploy "./ignition/modules/deployPortfolioRouter.ts" --network "$network" --verify
        # Vet router after deployment
        GATEWAY_CONTRACT="$GATEWAY" \
            AXELAR_SOURCE_CHAIN="$AXELAR_SOURCE_CHAIN" \
            FACTORY_CONTRACT="$REMOTE_ACCOUNT_FACTORY" \
            PERMIT2_CONTRACT="$PERMIT2" \
            npx hardhat run "./scripts/deployAndVetPortfolioRouter.mts" --network "$network"
        ;;
    *)
        echo "Error: Invalid contract type '$contract'"
        echo "Valid options: 'factory', 'depositFactory', 'remoteAccountFactory', or 'portfolioRouter'"
        exit 1
        ;;
esac

echo ""
echo "========================================="
echo "Deployment Complete!"
echo "========================================="
