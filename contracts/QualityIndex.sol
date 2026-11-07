// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "./ActorRegistry.sol";

contract QualityIndex {
    uint256 private constant SCALE = 10000;

    uint256 private constant SI_FORAGE = 3741;
    uint256 private constant SI_LIGHT_INTENSITY = 1715;
    uint256 private constant SI_WATER_SOURCE = 1488;
    uint256 private constant SI_SUMMER_TEMP = 1120;
    uint256 private constant SI_WINTER_TEMP = 789;
    uint256 private constant SI_WIND = 526;
    uint256 private constant SI_HUMIDITY = 364;
    uint256 private constant SI_PRECIPITATION = 256;

    uint256 private constant WATER_GATEKEEPER_THRESHOLD = 2300;

    uint256 private constant MCI_VARIETY = 1924;
    uint256 private constant MCI_REGION = 4668;
    uint256 private constant MCI_ORGANIC = 1618;
    uint256 private constant MCI_AWARD = 1790;

    uint256 private constant QI_PHQI = 5390;
    uint256 private constant QI_MCI = 2972;
    uint256 private constant QI_SI = 1638;

    ActorRegistry public actorRegistry;
    address public supplyChain;

    enum BatchState {
        Active,
        RetestRequired,
        NotSellable
    }
    enum GatekeeperReason {
        None,
        WaterContentExceeded,
        TemperatureViolation
    }

    struct SIInput {
        uint16 forage;
        uint16 lightIntensity;
        uint16 waterSource;
        uint16 summerTemperature;
        uint16 winterTemperature;
        uint16 windSpeed;
        uint16 humidity;
        uint16 precipitation;
    }

    struct PHQIInput {
        uint16 normalizedWaterContent;
        uint16 hmf;
        uint16 invertaseActivity;
        uint16 waterContentPercent;
    }

    struct MCIData {
        uint16 variety;
        uint16 region;
        uint16 organic;
        uint16 award;
    }

    struct QualityData {
        uint256 si;
        uint256 phqi;
    }

    mapping(uint256 => QualityData) public qualityData;
    mapping(uint256 => MCIData) public mciData;
    mapping(uint256 => BatchState) public batchStates;
    mapping(uint256 => GatekeeperReason) public gatekeeperFlags;
    mapping(uint256 => string) public phqiReportCid;
    mapping(uint256 => string) public awardCertificateCid;
    mapping(uint256 => string) public originCid;

    modifier onlySupplyChain() {
        require(
            msg.sender == supplyChain,
            "QualityIndex: caller is not SupplyChain"
        );
        _;
    }

    modifier onlyRole(bytes32 role) {
        require(
            actorRegistry.hasRole(role, msg.sender),
            "QualityIndex: missing role"
        );
        _;
    }

    constructor(address actorRegistryAddress) {
        actorRegistry = ActorRegistry(actorRegistryAddress);
    }

    function setSupplyChain(
        address supplyChainAddress
    ) external onlyRole(actorRegistry.DEFAULT_ADMIN_ROLE()) {
        supplyChain = supplyChainAddress;
    }

    function submitSIData(
        uint256 batchId,
        SIInput calldata input
    ) external onlyRole(actorRegistry.BEEKEEPER_ROLE()) {
        qualityData[batchId].si = calculateSI(input);
    }

    event PHQIDataSubmitted(uint256 indexed batchId, string ipfsCid);

    function submitPHQIData(
        uint256 batchId,
        PHQIInput calldata input,
        uint16 variety,
        string calldata ipfsCid
    ) external onlyRole(actorRegistry.LAB_ROLE()) {
        (uint256 phqi, GatekeeperReason reason) = calculatePHQI(input);
        qualityData[batchId].phqi = phqi;
        mciData[batchId].variety = variety;
        phqiReportCid[batchId] = ipfsCid;
        emit PHQIDataSubmitted(batchId, ipfsCid);

        if (reason == GatekeeperReason.WaterContentExceeded) {
            gatekeeperFlags[batchId] = GatekeeperReason.WaterContentExceeded;
            batchStates[batchId] = BatchState.NotSellable;
        } else {
            gatekeeperFlags[batchId] = GatekeeperReason.None;
            batchStates[batchId] = BatchState.Active;
        }
    }

    function submitOrigin(
        uint256 batchId,
        uint16 region,
        string calldata ipfsCid
    ) external onlyRole(actorRegistry.BEEKEEPER_ROLE()) {
        (, uint16 organicScore) = actorRegistry.certifications(msg.sender);
        mciData[batchId].region = region;
        mciData[batchId].organic = organicScore;
        originCid[batchId] = ipfsCid;
    }

    function submitAward(
        uint256 batchId,
        uint16 level,
        string calldata ipfsCid
    ) external onlyRole(actorRegistry.AWARD_BODY_ROLE()) {
        mciData[batchId].award = level;
        awardCertificateCid[batchId] = ipfsCid;
    }

    function calculateSI(SIInput calldata input) public pure returns (uint256) {
        return
            (uint256(input.forage) *
                SI_FORAGE +
                uint256(input.lightIntensity) *
                SI_LIGHT_INTENSITY +
                uint256(input.waterSource) *
                SI_WATER_SOURCE +
                uint256(input.summerTemperature) *
                SI_SUMMER_TEMP +
                uint256(input.winterTemperature) *
                SI_WINTER_TEMP +
                uint256(input.windSpeed) *
                SI_WIND +
                uint256(input.humidity) *
                SI_HUMIDITY +
                uint256(input.precipitation) *
                SI_PRECIPITATION) / SCALE;
    }

    function calculatePHQI(
        PHQIInput calldata input
    ) public pure returns (uint256 phqi, GatekeeperReason reason) {
        if (input.waterContentPercent > WATER_GATEKEEPER_THRESHOLD) {
            return (0, GatekeeperReason.WaterContentExceeded);
        }
        if (
            input.normalizedWaterContent == 0 ||
            input.hmf == 0 ||
            input.invertaseActivity == 0
        ) {
            return (0, GatekeeperReason.None);
        }

        phqi =
            (uint256(input.normalizedWaterContent) +
                uint256(input.hmf) +
                uint256(input.invertaseActivity)) /
            3;
        reason = GatekeeperReason.None;
    }

    function calculateMCI(uint256 batchId) public view returns (uint256) {
        MCIData memory data = mciData[batchId];
        return
            (uint256(data.variety) *
                MCI_VARIETY +
                uint256(data.region) *
                MCI_REGION +
                uint256(data.organic) *
                MCI_ORGANIC +
                uint256(data.award) *
                MCI_AWARD) / SCALE;
    }

    function calculateQI(uint256 batchId) public view returns (uint256) {
        uint256 si = qualityData[batchId].si;
        uint256 phqi = qualityData[batchId].phqi;
        uint256 mci = calculateMCI(batchId);
        return (phqi * QI_PHQI + mci * QI_MCI + si * QI_SI) / SCALE;
    }

    function checkGatekeeper(
        uint256 batchId
    ) external view returns (bool sellable, GatekeeperReason reason) {
        reason = gatekeeperFlags[batchId];
        sellable = batchStates[batchId] != BatchState.NotSellable;
    }

    function triggerTemperatureViolation(
        uint256 batchId
    ) external onlySupplyChain {
        if (batchStates[batchId] == BatchState.NotSellable) {
            return;
        }
        gatekeeperFlags[batchId] = GatekeeperReason.TemperatureViolation;
        batchStates[batchId] = BatchState.RetestRequired;
    }

    function getQualityData(
        uint256 batchId
    )
        external
        view
        returns (
            uint256 si,
            uint256 phqi,
            uint256 mci,
            uint256 qi,
            BatchState state,
            GatekeeperReason reason
        )
    {
        si = qualityData[batchId].si;
        phqi = qualityData[batchId].phqi;
        mci = calculateMCI(batchId);
        qi = calculateQI(batchId);
        state = batchStates[batchId];
        reason = gatekeeperFlags[batchId];
    }
}
