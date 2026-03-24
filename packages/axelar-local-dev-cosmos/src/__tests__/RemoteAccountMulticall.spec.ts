import AxelarGasService from '@axelar-network/axelar-cgp-solidity/artifacts/contracts/gas-service/AxelarGasService.sol/AxelarGasService.json';
import { expect } from 'chai';
import { Contract, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { ethers } from 'hardhat';
import '@nomicfoundation/hardhat-chai-matchers';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { AbiSend, makeEvmContract } from '../utils/evm-facade';
import { contractWithCallMetadata } from '../utils/router';
import type { AbiExtendedContractMethod } from '../utils/router';
import type { ContractCall } from '../interfaces/router';
import {
    computeRemoteAccountAddress,
    deployRemoteAccountFactory,
    ParsedLog,
    routed,
} from './lib/utils';
import { multicallAbi } from './interfaces/multicall';

const getContractCallSuccessEvents = async (receipt: {
    parseLogs: (iface: Interface) => ParsedLog[];
}) => {
    const RemoteAccount = await ethers.getContractFactory('RemoteAccount');
    return receipt
        .parseLogs(RemoteAccount.interface)
        .filter((e) => e.name === 'ContractCallSuccess');
};

/**
 * Tests for RemoteAccount multicall functionality via RemoteAccountAxelarRouter.
 *
 * The Multicall contract is a mock target for testing. In production,
 * RemoteAccount.executeCalls() deploys funds to EVM protocols.
 *
 * These tests verify multicalls execute correctly without breaking.
 */
describe('RemoteAccountAxelarRouter - RemoteAccountMulticall', () => {
    let owner: HardhatEthersSigner, addr1: HardhatEthersSigner;
    let axelarGatewayMock: Contract, axelarGasServiceMock: Contract;
    let factory: Contract, router: Contract, permit2Mock: Contract;
    let multicallTarget: Contract;
    let accountAddress: `0x${string}`;
    type BaseMulticallContract = ReturnType<typeof makeEvmContract<typeof multicallAbi>>;
    let multicallContract: ReturnType<typeof contractWithCallMetadata<BaseMulticallContract>>;

    const abiCoder = new ethers.AbiCoder();

    const sourceChain = 'agoric';
    const portfolioContractCaip2 = 'cosmos:agoric-3';
    const portfolioContractAccount = 'agoric1routerlca123456789abcdefghijklmnopqrs';
    const portfolioLCA = 'agoric1multicall123456789abcdefghijklmno';

    let route: ReturnType<typeof routed>;
    let routeConfig: Parameters<typeof routed>[1];

    before(async () => {
        [owner, addr1] = await ethers.getSigners();

        // Deploy Axelar Gas Service
        const GasServiceFactory = await ethers.getContractFactory(
            AxelarGasService.abi,
            AxelarGasService.bytecode,
        );
        axelarGasServiceMock = await GasServiceFactory.deploy(owner.address);

        // Deploy Token Deployer
        const TokenDeployerFactory = await ethers.getContractFactory('TokenDeployer');
        const tokenDeployer = await TokenDeployerFactory.deploy();

        // Deploy Auth Contract
        const AuthFactory = await ethers.getContractFactory('AxelarAuthWeighted');
        const authContract = await AuthFactory.deploy([
            abiCoder.encode(['address[]', 'uint256[]', 'uint256'], [[owner.address], [1], 1]),
        ]);

        // Deploy Axelar Gateway
        const AxelarGatewayFactory = await ethers.getContractFactory('AxelarGateway');
        axelarGatewayMock = await AxelarGatewayFactory.deploy(
            authContract.target,
            tokenDeployer.target,
        );

        // Deploy MockPermit2
        const MockPermit2Factory = await ethers.getContractFactory('MockPermit2');
        permit2Mock = await MockPermit2Factory.deploy();

        // Deploy RemoteAccount implementation + RemoteAccountFactory
        factory = await deployRemoteAccountFactory(
            portfolioContractCaip2,
            portfolioContractAccount,
            owner.address,
        );

        // Deploy RemoteAccountAxelarRouter
        const RouterContract = await ethers.getContractFactory('RemoteAccountAxelarRouter');
        router = await RouterContract.deploy(
            axelarGatewayMock.target,
            sourceChain,
            factory.target,
            permit2Mock.target,
        );
        await router.waitForDeployment();

        await factory.getFunction('vetInitialRouter')(router.target);

        // Deploy Multicall target for tests
        const MulticallFactory = await ethers.getContractFactory('Multicall');
        multicallTarget = await MulticallFactory.deploy();
        multicallContract = contractWithCallMetadata(
            makeEvmContract(multicallAbi),
            multicallTarget.target.toString() as `0x${string}`,
        );

        // Compute account address (account will be created in first test)
        accountAddress = await computeRemoteAccountAddress(factory.target.toString(), portfolioLCA);

        routeConfig = {
            sourceChain,
            owner,
            portfolioContractAccount,
            AxelarGateway: axelarGatewayMock,
            abiCoder,
        };
        route = routed(router, routeConfig);
    });

    it('should create account and execute multicall in single call', async () => {
        const multiCalls: ContractCall[] = [multicallContract.setValue(42n)];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        const operationResult = receipt.expectOperationSuccess();
        expect(operationResult.args.txIdPlaintext).to.equal(receipt.txId);
        expect(operationResult.args.sourceAddressIndex.hash).to.equal(
            keccak256(toUtf8Bytes(portfolioLCA)),
        );
        expect(operationResult.args.allegedRemoteAccount).to.equal(
            await route(portfolioLCA).getRemoteAccountAddress(),
        );

        expect(operationResult.args.instructionSelector).to.equal(
            router.interface.getFunction('processRemoteAccountExecuteInstruction')!.selector,
        );

        const successEvents = await getContractCallSuccessEvents(receipt);
        expect(successEvents).to.have.a.lengthOf(1);
        expect(successEvents[0].args.target).to.equal(multiCalls[0].target);
        expect(successEvents[0].args.selector).to.equal(multiCalls[0].data.slice(0, 10));
        expect(successEvents[0].args.callIndex).to.equal(0);
        expect(successEvents[0].args.gasUsed).to.be.gt(2000);

        expect(await multicallTarget.getValue()).to.equal(42n);
    });

    it('should execute multiple calls in sequence', async () => {
        const multiCalls: ContractCall[] = [
            multicallContract.setValue(100n),
            multicallContract.addToValue(5n),
        ];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        receipt.expectOperationSuccess();

        const successEvents = await getContractCallSuccessEvents(receipt);
        expect(successEvents).to.have.a.lengthOf(2);
        expect(successEvents[0].args.target).to.equal(multiCalls[0].target);
        expect(successEvents[0].args.selector).to.equal(multiCalls[0].data.slice(0, 10));
        expect(successEvents[0].args.callIndex).to.equal(0);
        expect(successEvents[0].args.gasUsed).to.be.gt(2000);
        expect(successEvents[1].args.target).to.equal(multiCalls[1].target);
        expect(successEvents[1].args.selector).to.equal(multiCalls[1].data.slice(0, 10));
        expect(successEvents[1].args.callIndex).to.equal(1);
        expect(successEvents[1].args.gasUsed).to.be.gt(2000);

        expect(await multicallTarget.getValue()).to.equal(105n);
    });

    it('should emit failure when multicall reverts', async () => {
        const multiCalls: ContractCall[] = [multicallContract.alwaysReverts()];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        const errorEvent = receipt.expectOperationFailure();
        const RemoteAccount = await ethers.getContractFactory('RemoteAccount');
        const decoded = RemoteAccount.interface.parseError(errorEvent.args.reason);
        expect(decoded?.name).to.equal('ContractCallFailed');
        expect(decoded?.args.target).to.equal(multiCalls[0].target);
        expect(decoded?.args.selector).to.equal(multiCalls[0].data.slice(0, 10));
        expect(decoded?.args.callIndex).to.equal(0);
        const error = new Error('Synthetic call failure');
        Object.assign(error, { data: decoded?.args.reason });
        await expect(Promise.reject(error)).to.be.revertedWith('Multicall: intentional revert');
    });

    it('should revert all calls when second call in batch fails', async () => {
        // Set a known value first
        const setupCalls: ContractCall[] = [multicallContract.setValue(500n)];
        (
            await route(portfolioLCA).doRemoteAccountExecute({ multiCalls: setupCalls })
        ).expectOperationSuccess();
        expect(await multicallTarget.getValue()).to.equal(500n);

        // Batch: first call sets value to 999, second call reverts
        const multiCalls: ContractCall[] = [
            multicallContract.setValue(999n),
            multicallContract.alwaysReverts(),
        ];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        receipt.expectOperationFailure();

        // Value should still be 500 — the first call's setValue(999) was rolled back
        expect(await multicallTarget.getValue()).to.equal(500n);
    });

    it('should respect explicit gasLimit on a call', async () => {
        // Use burnGas(10) with a generous gasLimit — should succeed
        const multiCalls: ContractCall[] = [
            multicallContract.burnGas.with({ gasLimit: BigInt(500_000) })(10n),
        ];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        receipt.expectOperationSuccess();

        const successEvents = await getContractCallSuccessEvents(receipt);
        expect(successEvents).to.have.a.lengthOf(1);
        expect(successEvents[0].args.gasUsed).to.be.gt(0);
        // gasUsed should be well under the 500k limit for just 10 iterations
        expect(successEvents[0].args.gasUsed).to.be.lt(500_000);
    });

    it('should fail when gasLimit is too low for the call', async () => {
        // Use burnGas(100) with a very tight gasLimit — should OOG inside the call
        const multiCalls: ContractCall[] = [
            multicallContract.burnGas.with({ gasLimit: BigInt(1_000) })(100n),
        ];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        const errorEvent = receipt.expectOperationFailure();
        const RemoteAccount = await ethers.getContractFactory('RemoteAccount');
        const decoded = RemoteAccount.interface.parseError(errorEvent.args.reason);
        expect(decoded?.name).to.equal('ContractCallFailed');
        expect(decoded?.args.callIndex).to.equal(0);
        // Empty reason because the subcall ran out of gas
        expect(decoded?.args.reason).to.equal('0x');
    });

    it('should send value to a payable method', async () => {
        const sendAmount = ethers.parseEther('1');

        // Fund the RemoteAccount so it has ETH to send
        await owner.sendTransaction({ to: accountAddress, value: sendAmount });
        expect(await ethers.provider.getBalance(accountAddress)).to.equal(sendAmount);

        const multiCalls: ContractCall[] = [
            multicallContract.depositToken.with({ value: sendAmount })(),
        ];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        receipt.expectOperationSuccess();

        const successEvents = await getContractCallSuccessEvents(receipt);
        expect(successEvents).to.have.a.lengthOf(1);

        // ETH moved from RemoteAccount to Multicall target
        expect(await ethers.provider.getBalance(accountAddress)).to.equal(0n);
        expect(await ethers.provider.getBalance(multicallTarget.target)).to.equal(sendAmount);
    });

    it('should send value to a contract receive function', async () => {
        const sendAmount = ethers.parseEther('0.5');
        const targetBalanceBefore = await ethers.provider.getBalance(multicallTarget.target);

        // Fund the RemoteAccount
        await owner.sendTransaction({ to: accountAddress, value: sendAmount });

        const send = multicallContract[AbiSend] as AbiExtendedContractMethod<[]>;
        const multiCalls: ContractCall[] = [send.with({ value: sendAmount })()];

        const receipt = await route(portfolioLCA).doRemoteAccountExecute({ multiCalls });
        receipt.expectOperationSuccess();

        const successEvents = await getContractCallSuccessEvents(receipt);
        expect(successEvents).to.have.a.lengthOf(1);
        // selector should be 0x00000000 for empty calldata
        expect(successEvents[0].args.selector).to.equal('0x00000000');

        expect(await ethers.provider.getBalance(accountAddress)).to.equal(0n);
        expect(await ethers.provider.getBalance(multicallTarget.target)).to.equal(
            targetBalanceBefore + sendAmount,
        );
    });

    it('should reject multicall with wrong controller', async () => {
        const wrongPortfolioLCA = 'agoric1wrongcontroller123456789abcdefgh';

        const multiCalls: ContractCall[] = [multicallContract.setValue(999n)];

        // Use correct account address but wrong source address (wrongPortfolioLCA)
        const receipt = await route(portfolioLCA, {
            sourceAddress: wrongPortfolioLCA,
        }).doRemoteAccountExecute({
            multiCalls,
        });
        const decodedError = receipt.parseOperationError(factory.interface);
        expect(decodedError?.name).to.equal('AddressMismatch');
    });

    it('should enable vetted router and allow it to operate accounts', async () => {
        // Deploy a new router
        const RouterContract = await ethers.getContractFactory('RemoteAccountAxelarRouter');
        const newRouter = await RouterContract.deploy(
            axelarGatewayMock.target,
            sourceChain,
            factory.target,
            permit2Mock.target,
        );
        await newRouter.waitForDeployment();

        // Vet the new router via the current router's owner
        await factory.getFunction('vetRouter')(newRouter.target);

        // Enable the new router via GMP from factory principal
        (
            await route(portfolioContractAccount).doEnableRouter({
                router: newRouter.target as `0x${string}`,
            })
        ).expectOperationSuccess();

        // New router can create and operate accounts
        const newRoute = routed(newRouter, routeConfig);
        const newPortfolioLCA = 'agoric1newportfolio123456789abcdefghijk';

        (
            await newRoute(newPortfolioLCA).doRemoteAccountExecute({
                multiCalls: [],
            })
        ).expectOperationSuccess();

        // New router can execute multicalls on existing accounts
        const multiCalls2: ContractCall[] = [multicallContract.setValue(999n)];
        const receipt3 = await newRoute(portfolioLCA).doRemoteAccountExecute({
            multiCalls: multiCalls2,
        });
        receipt3.expectOperationSuccess();
        expect(await multicallTarget.getValue()).to.equal(999n);

        // Old router is still enabled and can still operate alongside new router
        const anotherLCA = 'agoric1anotherportfolio123456789abcdefg';
        const receiptStillEnabled = await route(anotherLCA).doRemoteAccountExecute({
            multiCalls: [],
        });
        receiptStillEnabled.expectOperationSuccess();
    });

    it('should allow enabled experimental router to operate alongside main router', async () => {
        // Deploy experimental router
        const RouterContract = await ethers.getContractFactory('RemoteAccountAxelarRouter');
        const expRouter = await RouterContract.deploy(
            axelarGatewayMock.target,
            sourceChain,
            factory.target,
            permit2Mock.target,
        );
        await expRouter.waitForDeployment();

        // Vet and enable the experimental router
        await factory.getFunction('vetRouter')(expRouter.target);
        (
            await route(portfolioContractAccount).doEnableRouter({
                router: expRouter.target as `0x${string}`,
            })
        ).expectOperationSuccess();

        // Experimental router can operate accounts
        const expRoute = routed(expRouter, routeConfig);
        const expLCA = 'agoric1experimentalrouter123456789abcde';
        (
            await expRoute(expLCA).doRemoteAccountExecute({ multiCalls: [] })
        ).expectOperationSuccess();

        // Main router can also still operate
        const mainLCA = 'agoric1mainroutertest12345678901234abcde';
        (await route(mainLCA).doRemoteAccountExecute({ multiCalls: [] })).expectOperationSuccess();
    });

    it('should reject enabling an un-vetted router', async () => {
        // Try to enable an un-vetted address
        const receipt = await route(portfolioContractAccount).doEnableRouter({
            router: addr1.address as `0x${string}`,
        });
        const decodedError = receipt.parseOperationError(factory.interface);
        expect(decodedError?.name).to.equal('RouterNotVetted');
    });

    it('should reject enableRouter from non-factory-principal', async () => {
        // Deploy and vet a target router
        const RouterContract = await ethers.getContractFactory('RemoteAccountAxelarRouter');
        const targetRouter = await RouterContract.deploy(
            axelarGatewayMock.target,
            sourceChain,
            factory.target,
            permit2Mock.target,
        );
        await targetRouter.waitForDeployment();
        await factory.getFunction('vetRouter')(targetRouter.target);

        // Try enableRouter from a non-principal source (portfolioLCA resolves to account address, not factory)
        const receipt = await route(portfolioLCA).doEnableRouter({
            router: targetRouter.target as `0x${string}`,
        });
        const decodedError = receipt.parseOperationError(router.interface);
        expect(decodedError?.name).to.equal('UnauthorizedCaller');
    });
});
