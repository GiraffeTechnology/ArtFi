// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ArtFiCharityEditions} from "../src/ArtFiCharityEditions.sol";

contract UntrustedEditionCaller {
    function createSeries(ArtFiCharityEditions editions) external {
        editions.createSeries(
            keccak256("UNIT-A01"),
            sha256("master-a01"),
            sha256("metadata-a01"),
            address(this),
            "ipfs://bafy-charity-edition-a01"
        );
    }
}

contract CharityEditionsTest is IERC1155Receiver {
    ArtFiCharityEditions private editions;
    UntrustedEditionCaller private untrusted;

    bytes32 private constant ARTWORK_ID = keccak256("UNIT-A01");
    bytes32 private constant MASTER_HASH = sha256("master-a01");
    bytes32 private constant METADATA_HASH = sha256("metadata-a01");
    string private constant METADATA_URI = "ipfs://bafy-charity-edition-a01";

    function setUp() public {
        editions =
            new ArtFiCharityEditions(address(this), address(this), address(this), address(this));
        untrusted = new UntrustedEditionCaller();
    }

    function testCreatesExactlyOneHundredImmutableEditions() public {
        uint256 tokenId = _createSeries();

        require(tokenId == 1, "unexpected token id");
        require(editions.EDITIONS_PER_ARTWORK() == 100, "edition constant");
        require(editions.PRIMARY_PRICE_WEI() == 0.01 ether, "price constant");
        require(editions.totalSupply(tokenId) == 100, "series supply");
        require(editions.totalSupply() == 100, "collection supply");
        require(editions.balanceOf(address(this), tokenId) == 100, "distribution balance");
        require(keccak256(bytes(editions.uri(tokenId))) == keccak256(bytes(METADATA_URI)), "uri");

        ArtFiCharityEditions.Series memory record = editions.series(tokenId);
        require(record.artworkId == ARTWORK_ID, "artwork id");
        require(record.masterArtworkHash == MASTER_HASH, "master hash");
        require(record.metadataHash == METADATA_HASH, "metadata hash");
        require(record.distributionWallet == address(this), "distribution wallet");
    }

    function testSupportsERC1155AndMetadataInterfaces() public view {
        require(editions.supportsInterface(0xd9b67a26), "ERC-1155 interface");
        require(editions.supportsInterface(0x0e89341c), "ERC-1155 metadata interface");
    }

    function testDuplicateArtworkAndMasterCannotCreateAnotherSeries() public {
        _createSeries();

        (bool sameArtwork,) = address(editions)
            .call(
                abi.encodeCall(
                    editions.createSeries,
                    (
                        ARTWORK_ID,
                        sha256("different-master"),
                        sha256("different-metadata"),
                        address(this),
                        "ipfs://different-artwork"
                    )
                )
            );
        require(!sameArtwork, "duplicate artwork accepted");

        (bool sameMaster,) = address(editions)
            .call(
                abi.encodeCall(
                    editions.createSeries,
                    (
                        keccak256("UNIT-A04"),
                        MASTER_HASH,
                        sha256("different-metadata"),
                        address(this),
                        "ipfs://different-master"
                    )
                )
            );
        require(!sameMaster, "duplicate master accepted");
        require(editions.seriesCount() == 1, "duplicate changed count");
        require(editions.totalSupply() == 100, "duplicate changed supply");
    }

    function testUnauthorizedCreationIsRejected() public {
        (bool ok,) = address(untrusted).call(abi.encodeCall(untrusted.createSeries, (editions)));
        require(!ok, "unauthorized creation accepted");
        require(editions.seriesCount() == 0, "unauthorized creation changed state");
    }

    function testSupplyRemainsOneHundredAcrossTransfers() public {
        uint256 tokenId = _createSeries();
        editions.safeTransferFrom(address(this), address(0xBEEF), tokenId, 40, "");

        require(editions.balanceOf(address(this), tokenId) == 60, "sender balance");
        require(editions.balanceOf(address(0xBEEF), tokenId) == 40, "recipient balance");
        require(editions.totalSupply(tokenId) == 100, "supply changed");
    }

    function testDonationLifecycleRequiresSelloutAndEvidence() public {
        uint256 tokenId = _createSeries();
        bytes32 selloutEvidence = sha256("100-reconciled-primary-sales");
        bytes32 donationEvidence = sha256("cchs-physical-donation-acceptance");

        _requireCallFails(
            abi.encodeCall(editions.recordSellout, (tokenId, selloutEvidence)),
            "sellout recorded with distributor balance"
        );
        _requireCallFails(
            abi.encodeCall(editions.recordPhysicalDonation, (tokenId, donationEvidence)),
            "donation recorded before sellout"
        );

        editions.safeTransferFrom(address(this), address(0xBEEF), tokenId, 100, "");
        editions.recordSellout(tokenId, selloutEvidence);
        editions.recordPhysicalDonation(tokenId, donationEvidence);

        ArtFiCharityEditions.Series memory record = editions.series(tokenId);
        require(record.selloutEvidenceHash == selloutEvidence, "sellout evidence");
        require(record.physicalDonationEvidenceHash == donationEvidence, "donation evidence");
        require(record.soldOutAt != 0, "sellout timestamp");
        require(record.physicalDonationRecordedAt != 0, "donation timestamp");
        require(editions.totalSupply(tokenId) == 100, "lifecycle changed supply");

        _requireCallFails(
            abi.encodeCall(editions.recordSellout, (tokenId, selloutEvidence)),
            "sellout recorded twice"
        );
        _requireCallFails(
            abi.encodeCall(editions.recordPhysicalDonation, (tokenId, donationEvidence)),
            "donation recorded twice"
        );
    }

    function testPauseBlocksCreationAndTransfers() public {
        editions.pause();
        _requireCallFails(
            abi.encodeCall(
                editions.createSeries,
                (ARTWORK_ID, MASTER_HASH, METADATA_HASH, address(this), METADATA_URI)
            ),
            "created while paused"
        );
        editions.unpause();

        uint256 tokenId = _createSeries();
        editions.pause();
        _requireCallFails(
            abi.encodeCall(
                editions.safeTransferFrom, (address(this), address(0xBEEF), tokenId, 1, "")
            ),
            "transferred while paused"
        );
        _requireCallFails(
            abi.encodeCall(editions.recordSellout, (tokenId, sha256("sellout"))),
            "sellout recorded while paused"
        );
    }

    function testInvalidSeriesInputsAreRejected() public {
        _requireCreateFails(bytes32(0), MASTER_HASH, METADATA_HASH, address(this), METADATA_URI);
        _requireCreateFails(ARTWORK_ID, bytes32(0), METADATA_HASH, address(this), METADATA_URI);
        _requireCreateFails(ARTWORK_ID, MASTER_HASH, bytes32(0), address(this), METADATA_URI);
        _requireCreateFails(ARTWORK_ID, MASTER_HASH, METADATA_HASH, address(0), METADATA_URI);
        _requireCreateFails(ARTWORK_ID, MASTER_HASH, METADATA_HASH, address(this), "http://mutable");
    }

    function testFuzzTransfersNeverChangeFixedSupply(uint8 rawAmount) public {
        uint256 tokenId = _createSeries();
        uint256 amount = uint256(rawAmount) % 101;
        if (amount != 0) {
            editions.safeTransferFrom(address(this), address(0xBEEF), tokenId, amount, "");
        }
        require(editions.totalSupply(tokenId) == 100, "fuzz supply changed");
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function _createSeries() private returns (uint256) {
        return
            editions.createSeries(
                ARTWORK_ID, MASTER_HASH, METADATA_HASH, address(this), METADATA_URI
            );
    }

    function _requireCreateFails(
        bytes32 artworkId,
        bytes32 masterHash,
        bytes32 metadataHash,
        address distributionWallet,
        string memory metadataURI
    ) private {
        _requireCallFails(
            abi.encodeCall(
                editions.createSeries,
                (artworkId, masterHash, metadataHash, distributionWallet, metadataURI)
            ),
            "invalid series accepted"
        );
    }

    function _requireCallFails(bytes memory callData, string memory message) private {
        (bool ok,) = address(editions).call(callData);
        require(!ok, message);
    }
}
