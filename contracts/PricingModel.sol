// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "./ActorRegistry.sol";
import "./QualityIndex.sol";
import "./JarSizes.sol";

contract PricingModel {
    uint256 private constant SCALE = 10000;
    uint256 private constant SCALE_SQUARED = SCALE * SCALE;

    ActorRegistry public actorRegistry;
    QualityIndex public qualityIndex;

    uint256 public alpha;
    mapping(uint32 => uint256) public floorPrices; // Gramm => Preis in Cent

    modifier onlyRole(bytes32 role) {
        require(actorRegistry.hasRole(role, msg.sender), "PricingModel: missing role");
        _;
    }

    constructor(address actorRegistryAddress, address qualityIndexAddress, uint256 initialAlpha) {
        actorRegistry = ActorRegistry(actorRegistryAddress);
        qualityIndex = QualityIndex(qualityIndexAddress);
        alpha = initialAlpha;
    }

    function setAlpha(uint256 newAlpha) external onlyRole(actorRegistry.DEFAULT_ADMIN_ROLE()) {
        alpha = newAlpha;
    }

    function setFloorPrice(uint32 jarSizeGrams, uint256 priceCents) external onlyRole(actorRegistry.DEFAULT_ADMIN_ROLE()) {
        require(JarSizes.isValid(jarSizeGrams), "PricingModel: unsupported jar size");
        floorPrices[jarSizeGrams] = priceCents;
    }

    function calculatePriceForQI(uint256 qi, uint32 jarSizeGrams) public view returns (uint256) {
        uint256 floor = floorPrices[jarSizeGrams];
        require(floor > 0, "PricingModel: no floor price set for this jar size");

        return (floor * (SCALE_SQUARED + alpha * qi)) / SCALE_SQUARED;
    }

    function calculatePrice(uint256 batchId, uint32 jarSizeGrams) public view returns (uint256) {
        (bool sellable, ) = qualityIndex.checkGatekeeper(batchId);
        require(sellable, "PricingModel: batch is not sellable");

        uint256 qi = qualityIndex.calculateQI(batchId);
        return calculatePriceForQI(qi, jarSizeGrams);
    }

    function calculatePriceForPHQI(uint256 batchId, uint256 phqi, uint32 jarSizeGrams) external view returns (uint256) {
        uint256 qi = qualityIndex.calculateQIForPHQI(batchId, phqi);
        return calculatePriceForQI(qi, jarSizeGrams);
    }

    function getPrice(uint256 batchId, uint32 jarSizeGrams) external view returns (uint256) {
        return calculatePrice(batchId, jarSizeGrams);
    }
}
