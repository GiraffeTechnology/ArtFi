// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";

/// @title ArtCCH charity artwork editions
/// @notice One immutable ERC-1155 series per artwork, with exactly 100 editions minted once.
/// @dev This contract does not sell tokens, receive proceeds, expose artwork files, or operate an
///      exchange. External marketplace listings remain separately authorized actions.
contract ArtFiCharityEditions is ERC1155Supply, AccessControl, Pausable {
    bytes32 public constant SERIES_CREATOR_ROLE = keccak256("SERIES_CREATOR_ROLE");
    bytes32 public constant DONATION_RECORDER_ROLE = keccak256("DONATION_RECORDER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant EDITIONS_PER_ARTWORK = 100;
    uint256 public constant PRIMARY_PRICE_WEI = 0.01 ether;
    uint256 public constant MAX_URI_LENGTH = 512;
    uint256 public constant MAX_BATCH_SIZE = 37;
    bytes32 public constant WITHDRAWN_ARTWORK_ID = keccak256("UNIT-A02");
    bytes32 public constant CONTROLLING_INSCRIPTION_SHA256 =
        0x1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01;

    struct SeriesInput {
        bytes32 artworkId;
        bytes32 masterArtworkHash;
        bytes32 metadataHash;
        address distributionWallet;
        string metadataURI;
    }

    struct Series {
        bytes32 artworkId;
        bytes32 masterArtworkHash;
        bytes32 metadataHash;
        address distributionWallet;
        uint64 createdAt;
        uint64 soldOutAt;
        uint64 physicalDonationRecordedAt;
        bytes32 selloutEvidenceHash;
        bytes32 physicalDonationEvidenceHash;
        string metadataURI;
    }

    error DuplicateArtwork(bytes32 artworkId);
    error DuplicateMasterArtwork(bytes32 masterArtworkHash);
    error DuplicateMetadata(bytes32 metadataHash);
    error DuplicateMetadataURI(bytes32 metadataURIHash);
    error EmptyBatch();
    error BatchTooLarge(uint256 supplied, uint256 maximum);
    error BatchRecipientMismatch(address expected, address supplied);
    error EmptyArtworkId();
    error InvalidEvidenceHash();
    error InvalidMetadataHash();
    error InvalidMetadataURI();
    error SeriesNotFound(uint256 tokenId);
    error SeriesNotSoldOut(uint256 tokenId, uint256 remainingDistributorBalance);
    error SelloutAlreadyRecorded(uint256 tokenId);
    error PhysicalDonationAlreadyRecorded(uint256 tokenId);
    error SelloutNotRecorded(uint256 tokenId);
    error WithdrawnArtwork(bytes32 artworkId);
    error ZeroAddress();

    event SeriesCreated(
        uint256 indexed tokenId,
        bytes32 indexed artworkId,
        bytes32 indexed masterArtworkHash,
        address distributionWallet,
        bytes32 metadataHash,
        string metadataURI
    );
    event SelloutRecorded(uint256 indexed tokenId, bytes32 indexed evidenceHash);
    event PhysicalDonationRecorded(uint256 indexed tokenId, bytes32 indexed evidenceHash);
    event SeriesBatchCreated(
        uint256 indexed firstTokenId,
        uint256 indexed lastTokenId,
        uint256 seriesCount,
        address distributionWallet
    );

    uint256 public seriesCount;

    mapping(uint256 tokenId => Series series) private _series;
    mapping(bytes32 artworkId => uint256 tokenId) private _tokenByArtworkId;
    mapping(bytes32 masterArtworkHash => uint256 tokenId) private _tokenByMasterArtworkHash;
    mapping(bytes32 metadataHash => uint256 tokenId) private _tokenByMetadataHash;
    mapping(bytes32 metadataURIHash => uint256 tokenId) private _tokenByMetadataURIHash;

    constructor(address admin, address seriesCreator, address donationRecorder, address pauser)
        ERC1155("")
    {
        if (
            admin == address(0) || seriesCreator == address(0) || donationRecorder == address(0)
                || pauser == address(0)
        ) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SERIES_CREATOR_ROLE, seriesCreator);
        _grantRole(DONATION_RECORDER_ROLE, donationRecorder);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Creates one artwork series and mints its complete, permanent supply.
    /// @dev There is deliberately no follow-on mint or burn path.
    function createSeries(
        bytes32 artworkId,
        bytes32 masterArtworkHash,
        bytes32 metadataHash,
        address distributionWallet,
        string calldata metadataURI
    ) external onlyRole(SERIES_CREATOR_ROLE) whenNotPaused returns (uint256 tokenId) {
        tokenId = _createSeriesRecord(
            artworkId, masterArtworkHash, metadataHash, distributionWallet, metadataURI
        );
        _mint(distributionWallet, tokenId, EDITIONS_PER_ARTWORK, "");
    }

    /// @notice Atomically creates and mints a bounded group of artwork series to one wallet.
    /// @dev Any invalid or duplicate entry reverts the complete batch. The single-series entry point
    ///      remains available for future separately authorized iterations.
    function createSeriesBatch(SeriesInput[] calldata inputs)
        external
        onlyRole(SERIES_CREATOR_ROLE)
        whenNotPaused
        returns (uint256 firstTokenId, uint256 lastTokenId)
    {
        uint256 length = inputs.length;
        if (length == 0) revert EmptyBatch();
        if (length > MAX_BATCH_SIZE) revert BatchTooLarge(length, MAX_BATCH_SIZE);

        address distributionWallet = inputs[0].distributionWallet;
        if (distributionWallet == address(0)) revert ZeroAddress();

        uint256[] memory tokenIds = new uint256[](length);
        uint256[] memory amounts = new uint256[](length);
        for (uint256 i; i < length; ++i) {
            SeriesInput calldata input = inputs[i];
            if (input.distributionWallet != distributionWallet) {
                revert BatchRecipientMismatch(distributionWallet, input.distributionWallet);
            }
            tokenIds[i] = _createSeriesRecord(
                input.artworkId,
                input.masterArtworkHash,
                input.metadataHash,
                input.distributionWallet,
                input.metadataURI
            );
            amounts[i] = EDITIONS_PER_ARTWORK;
        }

        firstTokenId = tokenIds[0];
        lastTokenId = tokenIds[length - 1];
        _mintBatch(distributionWallet, tokenIds, amounts, "");
        emit SeriesBatchCreated(firstTokenId, lastTokenId, length, distributionWallet);
    }

    function _createSeriesRecord(
        bytes32 artworkId,
        bytes32 masterArtworkHash,
        bytes32 metadataHash,
        address distributionWallet,
        string calldata metadataURI
    ) private returns (uint256 tokenId) {
        if (artworkId == bytes32(0)) revert EmptyArtworkId();
        if (artworkId == WITHDRAWN_ARTWORK_ID) revert WithdrawnArtwork(artworkId);
        if (masterArtworkHash == bytes32(0)) revert InvalidEvidenceHash();
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
        if (distributionWallet == address(0)) revert ZeroAddress();
        if (!_validURI(metadataURI)) revert InvalidMetadataURI();
        if (_tokenByArtworkId[artworkId] != 0) revert DuplicateArtwork(artworkId);
        if (_tokenByMasterArtworkHash[masterArtworkHash] != 0) {
            revert DuplicateMasterArtwork(masterArtworkHash);
        }
        if (_tokenByMetadataHash[metadataHash] != 0) revert DuplicateMetadata(metadataHash);
        bytes32 metadataURIHash = keccak256(bytes(metadataURI));
        if (_tokenByMetadataURIHash[metadataURIHash] != 0) {
            revert DuplicateMetadataURI(metadataURIHash);
        }

        tokenId = ++seriesCount;
        _tokenByArtworkId[artworkId] = tokenId;
        _tokenByMasterArtworkHash[masterArtworkHash] = tokenId;
        _tokenByMetadataHash[metadataHash] = tokenId;
        _tokenByMetadataURIHash[metadataURIHash] = tokenId;
        _series[tokenId] = Series({
            artworkId: artworkId,
            masterArtworkHash: masterArtworkHash,
            metadataHash: metadataHash,
            distributionWallet: distributionWallet,
            createdAt: uint64(block.timestamp),
            soldOutAt: 0,
            physicalDonationRecordedAt: 0,
            selloutEvidenceHash: bytes32(0),
            physicalDonationEvidenceHash: bytes32(0),
            metadataURI: metadataURI
        });

        emit URI(metadataURI, tokenId);
        emit SeriesCreated(
            tokenId, artworkId, masterArtworkHash, distributionWallet, metadataHash, metadataURI
        );
    }

    /// @notice Records external evidence only after the original distribution wallet is empty.
    /// @dev A zero balance is necessary but not sufficient proof of 100 arm's-length purchases;
    ///      the evidence hash must bind the independently reconciled marketplace records.
    function recordSellout(uint256 tokenId, bytes32 evidenceHash)
        external
        onlyRole(DONATION_RECORDER_ROLE)
        whenNotPaused
    {
        Series storage record_ = _requireSeries(tokenId);
        if (record_.soldOutAt != 0) revert SelloutAlreadyRecorded(tokenId);
        if (evidenceHash == bytes32(0)) revert InvalidEvidenceHash();
        uint256 remainingBalance = balanceOf(record_.distributionWallet, tokenId);
        if (remainingBalance != 0) revert SeriesNotSoldOut(tokenId, remainingBalance);

        record_.soldOutAt = uint64(block.timestamp);
        record_.selloutEvidenceHash = evidenceHash;
        emit SelloutRecorded(tokenId, evidenceHash);
    }

    /// @notice Records the post-sellout physical donation acceptance evidence from CCHS.
    function recordPhysicalDonation(uint256 tokenId, bytes32 evidenceHash)
        external
        onlyRole(DONATION_RECORDER_ROLE)
        whenNotPaused
    {
        Series storage record_ = _requireSeries(tokenId);
        if (record_.soldOutAt == 0) revert SelloutNotRecorded(tokenId);
        if (record_.physicalDonationRecordedAt != 0) {
            revert PhysicalDonationAlreadyRecorded(tokenId);
        }
        if (evidenceHash == bytes32(0)) revert InvalidEvidenceHash();

        record_.physicalDonationRecordedAt = uint64(block.timestamp);
        record_.physicalDonationEvidenceHash = evidenceHash;
        emit PhysicalDonationRecorded(tokenId, evidenceHash);
    }

    function series(uint256 tokenId) external view returns (Series memory) {
        return _requireSeries(tokenId);
    }

    function tokenByArtworkId(bytes32 artworkId) external view returns (uint256) {
        return _tokenByArtworkId[artworkId];
    }

    function tokenByMasterArtworkHash(bytes32 masterArtworkHash) external view returns (uint256) {
        return _tokenByMasterArtworkHash[masterArtworkHash];
    }

    function tokenByMetadataHash(bytes32 metadataHash) external view returns (uint256) {
        return _tokenByMetadataHash[metadataHash];
    }

    function tokenByMetadataURI(string calldata metadataURI) external view returns (uint256) {
        return _tokenByMetadataURIHash[keccak256(bytes(metadataURI))];
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return _requireSeries(tokenId).metadataURI;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155Supply)
        whenNotPaused
    {
        super._update(from, to, ids, values);
    }

    function _requireSeries(uint256 tokenId) private view returns (Series storage series_) {
        series_ = _series[tokenId];
        if (series_.createdAt == 0) revert SeriesNotFound(tokenId);
    }

    function _validURI(string calldata metadataURI) private pure returns (bool) {
        bytes calldata value = bytes(metadataURI);
        if (value.length == 0 || value.length > MAX_URI_LENGTH) return false;
        return _startsWith(value, "ipfs://") || _startsWith(value, "https://");
    }

    function _startsWith(bytes calldata value, string memory prefix) private pure returns (bool) {
        bytes memory expected = bytes(prefix);
        if (value.length < expected.length) return false;
        for (uint256 i; i < expected.length; ++i) {
            if (value[i] != expected[i]) return false;
        }
        return true;
    }
}
