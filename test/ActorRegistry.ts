import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("ActorRegistry", function () {
    async function deploy() {
        const [admin, beekeeper, certBody, outsider] = await ethers.getSigners();
        const registry = await ethers.deployContract("ActorRegistry", [], admin);
        return { registry, admin, beekeeper, certBody, outsider };
    }

    it("grants DEFAULT_ADMIN_ROLE to the deployer", async function () {
        const { registry, admin } = await deploy();
        const DEFAULT_ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
        expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it("allows the admin to register an actor", async function () {
        const { registry, admin, beekeeper } = await deploy();
        await registry.connect(admin).registerActor(beekeeper.address, "Imkerei Mustermann");

        const actor = await registry.getActor(beekeeper.address);
        expect(actor.name).to.equal("Imkerei Mustermann");
        expect(actor.registered).to.equal(true);
    });

    it("rejects registerActor from a non-admin caller", async function () {
        const { registry, outsider, beekeeper } = await deploy();
        await expect(
            registry.connect(outsider).registerActor(beekeeper.address, "Imkerei Mustermann"),
        ).to.revert(ethers);
    });

    it("allows the admin to grant BEEKEEPER_ROLE", async function () {
        const { registry, admin, beekeeper } = await deploy();
        const BEEKEEPER_ROLE = await registry.BEEKEEPER_ROLE();

        await registry.connect(admin).grantRole(BEEKEEPER_ROLE, beekeeper.address);

        expect(await registry.hasRole(BEEKEEPER_ROLE, beekeeper.address)).to.equal(true);
    });

    const exampleCid = ethers.encodeBytes32String("bafybeituwoexamplecid");

    it("allows a CERTIFICATION_BODY_ROLE holder to set a certification CID", async function () {
        const { registry, admin, certBody, beekeeper } = await deploy();
        const CERTIFICATION_BODY_ROLE = await registry.CERTIFICATION_BODY_ROLE();
        await registry.connect(admin).grantRole(CERTIFICATION_BODY_ROLE, certBody.address);

        await registry.connect(certBody).setCertification(beekeeper.address, exampleCid, 5000);

        const certification = await registry.certifications(beekeeper.address);
        expect(certification.ipfsCid).to.equal(exampleCid);
        expect(certification.organicScore).to.equal(5000);
    });

    it("rejects setCertification from an account without CERTIFICATION_BODY_ROLE", async function () {
        const { registry, outsider, beekeeper } = await deploy();
        await expect(
            registry.connect(outsider).setCertification(beekeeper.address, exampleCid, 5000),
        ).to.revert(ethers);
    });
});
