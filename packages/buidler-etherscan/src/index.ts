import { extendConfig, task } from "@nomiclabs/buidler/config";
import {
  HARDHAT_NETWORK_NAME,
  NomicLabsHardhatPluginError,
} from "@nomiclabs/buidler/plugins";
import { ActionType } from "@nomiclabs/buidler/types";
import path from "path";
import semver from "semver";

import { defaultEtherscanConfig } from "./config";
import { pluginName } from "./pluginContext";
import "./type-extensions";

interface VerificationArgs {
  address: string;
  constructorArguments: string[];
  // Filename of constructor arguments module.
  constructorArgs?: string;
}

extendConfig(defaultEtherscanConfig);

const verify: ActionType<VerificationArgs> = async (
  {
    address,
    constructorArguments: constructorArgsList,
    constructorArgs: constructorArgsModule,
  },
  { config, network, run }
) => {
  const { etherscan } = config;

  if (etherscan.apiKey === undefined || etherscan.apiKey.trim() === "") {
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `Please provide an Etherscan API token via hardhat config.
E.g.: { [...], etherscan: { apiKey: 'an API key' }, [...] }
See https://etherscan.io/apis`
    );
  }

  if (network.name === HARDHAT_NETWORK_NAME) {
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `The selected network is ${network.name}. Please select a network supported by Etherscan.`
    );
  }

  const { isAddress } = await import("@ethersproject/address");
  if (!isAddress(address)) {
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `${address} is an invalid address.`
    );
  }

  const supportedSolcVersionRange = ">=0.4.11";
  // Etherscan only supports solidity versions higher than or equal to v0.4.11.
  // See https://etherscan.io/solcversions
  // TODO: perhaps querying and scraping this list would be a better approach?
  // This list should be validated - it links to https://github.com/ethereum/solc-bin/blob/gh-pages/bin/list.txt
  // which has many old compilers included in the list too.
  // TODO-HH: handle multiple compilers
  if (
    !semver.satisfies(
      config.solidity.compilers[0].version,
      supportedSolcVersionRange
    )
  ) {
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `Etherscan only supports compiler versions 0.4.11 and higher.
See https://etherscan.io/solcversions for more information.`
    );
  }

  let constructorArguments;
  if (typeof constructorArgsModule === "string") {
    if (!path.isAbsolute(constructorArgsModule)) {
      // This ensures that the npm package namespace is ignored.
      constructorArgsModule = path.join(process.cwd(), constructorArgsModule);
    }
    try {
      constructorArguments = (await import(constructorArgsModule)).default;
      if (!Array.isArray(constructorArguments)) {
        throw new NomicLabsHardhatPluginError(
          pluginName,
          `The module doesn't export a list. The module should look like this:
module.exports = [ arg1, arg2, ... ];`
        );
      }
    } catch (error) {
      throw new NomicLabsHardhatPluginError(
        pluginName,
        `Importing the module for the constructor arguments list failed.
Reason: ${error.message}`,
        error
      );
    }
  } else {
    constructorArguments = constructorArgsList;
  }

  let etherscanAPIEndpoint: URL;
  const {
    getEtherscanEndpoint,
    retrieveContractBytecode,
    NetworkProberError,
  } = await import("./network/prober");
  try {
    etherscanAPIEndpoint = await getEtherscanEndpoint(network.provider);
  } catch (error) {
    if (error instanceof NetworkProberError) {
      throw new NomicLabsHardhatPluginError(
        pluginName,
        `${error.message} The selected network is ${network.name}.

Possible causes are:
  - The selected network (${network.name}) is wrong.
  - Faulty buidler network config.`,
        error
      );
    }
    // Shouldn't be reachable.
    throw error;
  }

  const deployedContractBytecode = await retrieveContractBytecode(
    address,
    network.provider
  );
  if (deployedContractBytecode === null) {
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `The address ${address} has no bytecode. Is the contract deployed to this network?
The selected network is ${network.name}.`
    );
  }

  const { getLongVersion, inferSolcVersion, InferralType } = await import(
    "./solc/version"
  );
  const bytecodeBuffer = Buffer.from(deployedContractBytecode, "hex");
  const inferredSolcVersion = await inferSolcVersion(bytecodeBuffer);

  // TODO-HH: handle multiple compilers
  if (
    !semver.satisfies(
      config.solidity.compilers[0].version,
      inferredSolcVersion.range
    )
  ) {
    let detailedContext;
    if (inferredSolcVersion.inferralType === InferralType.EXACT) {
      detailedContext = `The expected version is ${inferredSolcVersion.range}.`;
    } else {
      detailedContext = `The expected version range is ${inferredSolcVersion.range}.`;
    }
    // TODO-HH: handle multiple compilers
    const message = `The bytecode retrieved could not have been generated by the selected compiler.
The selected compiler version is v${config.solidity.compilers[0].version}.
${detailedContext}

Possible causes are:
  - Wrong compiler version in hardhat config.
  - The given address is wrong.
  - The selected network (${network.name}) is wrong.`;
    throw new NomicLabsHardhatPluginError(pluginName, message);
  }

  const { lookupMatchingBytecode, compile } = await import("./solc/bytecode");
  // TODO: this gives us the input for all contracts.
  // This could be restricted to relevant contracts in a future iteration of the compiler tasks.
  const { compilerInput, compilerOutput } = await compile(run);

  const contractMatches = await lookupMatchingBytecode(
    compilerOutput.contracts,
    deployedContractBytecode,
    inferredSolcVersion.inferralType
  );
  if (contractMatches.length === 0) {
    const message = `The address provided as argument contains a contract, but its bytecode doesn't match any of your local contracts.

Possible causes are:
  - Contract code changed after the deployment was executed. This includes code for seemingly unrelated contracts.
  - A solidity file was added, moved, deleted or renamed after the deployment was executed. This includes files for seemingly unrelated contracts.
  - Solidity compiler settings were modified after the deployment was executed (like the optimizer, target EVM, etc.).
  - The given address is wrong.
  - The selected network (${network.name}) is wrong.`;
    throw new NomicLabsHardhatPluginError(pluginName, message);
  }
  if (contractMatches.length > 1) {
    const nameList = contractMatches
      .map((contract) => {
        return `${contract.contractFilename}:${contract.contractName}`;
      })
      .join(", ");
    const message = `More than one contract was found to match the deployed bytecode.
The plugin does not yet support this case. Contracts found:
${nameList}`;
    throw new NomicLabsHardhatPluginError(pluginName, message, undefined, true);
  }
  const [contractInformation] = contractMatches;

  const { encodeArguments } = await import("./ABIEncoder");
  const deployArgumentsEncoded = await encodeArguments(
    contractInformation.contract.abi,
    contractInformation.contractFilename,
    contractInformation.contractName,
    constructorArguments
  );

  // Ensure the linking information is present in the compiler input;
  compilerInput.settings.libraries = contractInformation.libraryLinks;
  const compilerInputJSON = JSON.stringify(compilerInput);

  // TODO-HH: handle multiple compilers
  const solcFullVersion = await getLongVersion(
    config.solidity.compilers[0].version
  );

  const { toVerifyRequest, toCheckStatusRequest } = await import(
    "./etherscan/EtherscanVerifyContractRequest"
  );
  const request = toVerifyRequest({
    apiKey: etherscan.apiKey,
    contractAddress: address,
    sourceCode: compilerInputJSON,
    contractFilename: contractInformation.contractFilename,
    contractName: contractInformation.contractName,
    compilerVersion: solcFullVersion,
    constructorArguments: deployArgumentsEncoded,
  });

  const { getVerificationStatus, verifyContract, delay } = await import(
    "./etherscan/EtherscanService"
  );
  const response = await verifyContract(etherscanAPIEndpoint, request);

  console.log(
    `Successfully submitted source code for contract
${contractInformation.contractFilename}:${contractInformation.contractName} at ${address}
for verification on etherscan. Waiting for verification result...`
  );

  const pollRequest = toCheckStatusRequest({
    apiKey: etherscan.apiKey,
    guid: response.message,
  });

  // Compilation is bound to take some time so there's no sense in requesting status immediately.
  await delay(700);
  const verificationStatus = await getVerificationStatus(
    etherscanAPIEndpoint,
    pollRequest
  );

  if (verificationStatus.isVerificationSuccess()) {
    console.log("Successfully verified contract on etherscan");
  } else {
    // Reaching this branch shouldn't be possible unless the API is behaving in a new way.
    throw new NomicLabsHardhatPluginError(
      pluginName,
      `The API responded with an unexpected message.
Contract verification may have succeeded and should be checked manually.
Message: ${verificationStatus.message}`,
      undefined,
      true
    );
  }
};

task("verify", "Verifies contract on etherscan")
  .addPositionalParam(
    "address",
    "Address of the smart contract that will be verified"
  )
  .addOptionalParam(
    "constructorArgs",
    "File path to a javascript module that exports the list of arguments."
  )
  .addOptionalVariadicPositionalParam(
    "constructorArguments",
    "Arguments used in the contract constructor. These are ignored if the --constructorArgs option is passed.",
    []
  )
  .setAction(verify);
