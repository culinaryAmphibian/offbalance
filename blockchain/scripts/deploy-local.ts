// Deploys OffBalance (and the dev-only OffBalanceEventMock) to the running
// `hardhat node` and writes addresses + ABIs to deployments/localhost.json for
// the Python client / server / frontend.
//
// Run against a fresh node so account #0 deploys at nonces 0 and 1, which
// always yields the same addresses (see ../dev.env).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifacts, network } from "hardhat";

const EXPECTED_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const EXPECTED_MOCK_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

const { viem } = await network.create({ network: "localhost" });
const [deployer] = await viem.getWalletClients();

const offBalance = await viem.deployContract("OffBalance", [], {
  client: { wallet: deployer },
});
const eventMock = await viem.deployContract("OffBalanceEventMock", [], {
  client: { wallet: deployer },
});
const { abi } = await artifacts.readArtifact("OffBalance");
const { abi: mockAbi } = await artifacts.readArtifact("OffBalanceEventMock");

const outDir = path.join(import.meta.dirname, "..", "deployments");
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "localhost.json"),
  JSON.stringify(
    {
      chainId: 31337,
      address: offBalance.address,
      deployer: deployer.account.address,
      abi,
      eventMock: { address: eventMock.address, abi: mockAbi },
    },
    null,
    2,
  ),
);

console.log(`OffBalance deployed to ${offBalance.address} by ${deployer.account.address}`);
console.log(`OffBalanceEventMock deployed to ${eventMock.address}`);
if (
  offBalance.address.toLowerCase() !== EXPECTED_ADDRESS.toLowerCase() ||
  eventMock.address.toLowerCase() !== EXPECTED_MOCK_ADDRESS.toLowerCase()
) {
  console.warn(
    `WARNING: expected ${EXPECTED_ADDRESS} / ${EXPECTED_MOCK_ADDRESS}. The node wasn't fresh, so the addresses in dev.env are stale. Restart the node and redeploy.`,
  );
}
