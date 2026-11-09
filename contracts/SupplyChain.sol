// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "./ActorRegistry.sol";
import "./HoneyToken.sol";
import "./QualityIndex.sol";
import "./JarSizes.sol";

contract SupplyChain {
    ActorRegistry public actorRegistry;
    HoneyToken public honeyToken;
    QualityIndex public qualityIndex;

    uint256 public nextBatchId = 1;

    int256 public maxSafeTemperatureCelsius = 40;
    uint256 public maxSafeDurationMinutes = 60;

    struct Batch {
        uint256 quantity;
        uint16 harvestYear;
        address beekeeper;
    }

    struct LocationContribution {
        uint64 standId;
        uint128 quantity;
    }

    struct CustodyRecord {
        address from;
        uint64 timestamp;
        address to;
    }

    mapping(uint256 => Batch) public batches;
    mapping(uint256 => LocationContribution[]) public batchLocations;
    mapping(uint256 => CustodyRecord[]) public custodyHistory;
    mapping(uint256 => address) public currentHolder;

    event BatchBottled(uint256 indexed batchId);

    modifier onlyRole(bytes32 role) {
        require(
            actorRegistry.hasRole(role, msg.sender),
            "SupplyChain: missing role"
        );
        _;
    }

    modifier onlyCurrentHolder(uint256 batchId) {
        require(
            currentHolder[batchId] == msg.sender,
            "SupplyChain: caller does not hold custody"
        );
        _;
    }

    modifier onlySellable(uint256 batchId) {
        QualityIndex.BatchState state = qualityIndex.batchStates(batchId);
        require(
            state != QualityIndex.BatchState.RetestRequired,
            "SupplyChain: batch requires a lab retest before it can proceed"
        );
        require(
            state != QualityIndex.BatchState.NotSellable,
            "SupplyChain: batch is not sellable"
        );
        _;
    }

    constructor(
        address actorRegistryAddress,
        address honeyTokenAddress,
        address qualityIndexAddress
    ) {
        actorRegistry = ActorRegistry(actorRegistryAddress);
        honeyToken = HoneyToken(honeyTokenAddress);
        qualityIndex = QualityIndex(qualityIndexAddress);
    }

    function setMaxSafeTemperature(
        int256 celsius
    ) external onlyRole(actorRegistry.DEFAULT_ADMIN_ROLE()) {
        maxSafeTemperatureCelsius = celsius;
    }

    function setMaxSafeDuration(
        uint256 minutesValue
    ) external onlyRole(actorRegistry.DEFAULT_ADMIN_ROLE()) {
        maxSafeDurationMinutes = minutesValue;
    }

    function registerHarvestBatch(
        uint16 harvestYear,
        uint256[] calldata standIds,
        uint256[] calldata locationQuantities
    )
        external
        onlyRole(actorRegistry.BEEKEEPER_ROLE())
        returns (uint256 batchId)
    {
        require(
            standIds.length == locationQuantities.length,
            "SupplyChain: length mismatch"
        );

        uint256 totalQuantity;
        for (uint256 i = 0; i < locationQuantities.length; i++) {
            totalQuantity += locationQuantities[i];
        }

        batchId = nextBatchId++;
        batches[batchId] = Batch(totalQuantity, harvestYear, msg.sender);
        currentHolder[batchId] = msg.sender;

        for (uint256 i = 0; i < standIds.length; i++) {
            require(standIds[i] <= type(uint64).max, "SupplyChain: standId too large");
            require(locationQuantities[i] <= type(uint128).max, "SupplyChain: quantity too large");
            batchLocations[batchId].push(
                LocationContribution(uint64(standIds[i]), uint128(locationQuantities[i]))
            );
        }

        honeyToken.mintBulkBatch(batchId, totalQuantity, msg.sender);
    }

    function transferCustody(
        uint256 batchId,
        address to
    ) external onlyCurrentHolder(batchId) onlySellable(batchId) {
        address from = msg.sender;
        currentHolder[batchId] = to;
        custodyHistory[batchId].push(CustodyRecord(from, uint64(block.timestamp), to));

        uint256[] memory candidateIds = new uint256[](4);
        candidateIds[0] = batchId;
        candidateIds[1] = honeyToken.jarTokenId(batchId, JarSizes.GRAMS_1000);
        candidateIds[2] = honeyToken.jarTokenId(batchId, JarSizes.GRAMS_500);
        candidateIds[3] = honeyToken.jarTokenId(batchId, JarSizes.GRAMS_250);

        uint256[] memory ids = new uint256[](4);
        uint256[] memory amounts = new uint256[](4);
        uint256 count;
        for (uint256 i = 0; i < 4; i++) {
            uint256 balance = honeyToken.balanceOf(from, candidateIds[i]);
            if (balance > 0) {
                ids[count] = candidateIds[i];
                amounts[count] = balance;
                count++;
            }
        }

        if (count > 0) {
            uint256[] memory finalIds = new uint256[](count);
            uint256[] memory finalAmounts = new uint256[](count);
            for (uint256 i = 0; i < count; i++) {
                finalIds[i] = ids[i];
                finalAmounts[i] = amounts[i];
            }
            honeyToken.safeBatchTransferFrom(
                from,
                to,
                finalIds,
                finalAmounts,
                ""
            );
        }
    }

    function processAndBottle(
        uint256 batchId,
        uint32[] calldata jarSizesGrams,
        uint256[] calldata jarCounts
    )
        external
        onlyRole(actorRegistry.BOTTLER_ROLE())
        onlyCurrentHolder(batchId)
        onlySellable(batchId)
    {
        honeyToken.mintJars(
            batchId,
            msg.sender,
            jarSizesGrams,
            jarCounts,
            msg.sender
        );
        honeyToken.markBatchProcessed(batchId);
        emit BatchBottled(batchId);
    }

    function recordTransportData(
        uint256 batchId,
        int256 temperatureCelsius,
        uint256 durationMinutes
    ) external onlyCurrentHolder(batchId) {
        if (
            temperatureCelsius > maxSafeTemperatureCelsius &&
            durationMinutes >= maxSafeDurationMinutes
        ) {
            qualityIndex.triggerTemperatureViolation(batchId);
        }
    }

    function recordWarehouseData(
        uint256 batchId,
        int256 temperatureCelsius,
        uint256 durationMinutes
    ) external onlyCurrentHolder(batchId) {
        if (
            temperatureCelsius > maxSafeTemperatureCelsius &&
            durationMinutes >= maxSafeDurationMinutes
        ) {
            qualityIndex.triggerTemperatureViolation(batchId);
        }
    }

    function getBatch(
        uint256 batchId
    ) external view returns (Batch memory batch, address holder) {
        batch = batches[batchId];
        holder = currentHolder[batchId];
    }
}
