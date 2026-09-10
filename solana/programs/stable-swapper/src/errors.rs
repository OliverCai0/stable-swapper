use anchor_lang::prelude::*;

#[error_code]
pub enum LiquidityError {
    #[msg("Swaps are paused")]
    SwapsPaused,
    #[msg("Withdrawals are paused")]
    WithdrawalPaused,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Token not supported")]
    TokenNotSupported,
    #[msg("Token already supported")]
    TokenAlreadySupported,
    #[msg("Cannot swap same token")]
    SameToken,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Invalid fee rate")]
    InvalidFeeRate,
    #[msg("Deprecated: previously InvalidReservedAmount")]
    DeprecatedInvalidReservedAmount,
    #[msg("Maximum number of supported tokens reached (50)")]
    MaxTokensReached,
    #[msg("Output amount below minimum acceptable (slippage exceeded)")]
    SlippageExceeded,
    #[msg("Invalid token decimals: must be between 6 and 9")]
    InvalidTokenDecimals,
    #[msg("Arithmetic overflow in fee calculation")]
    FeeCalculationOverflow,
    #[msg("Arithmetic overflow in decimal normalization")]
    DecimalNormalizationOverflow,
    #[msg("Token is disabled and cannot be used in swaps")]
    TokenDisabled,
    #[msg("Address not whitelisted")]
    NotWhitelisted,
    #[msg("Deprecated: previously MaxWhitelistedAddressesReached")]
    DeprecatedMaxWhitelistedAddressesReached,
    #[msg("Deprecated: previously AddressAlreadyWhitelisted")]
    DeprecatedAddressAlreadyWhitelisted,
    #[msg("Deprecated: previously AddressNotInWhitelist")]
    DeprecatedAddressNotInWhitelist,
    #[msg("Deprecated: previously InvalidWhitelistAccount")]
    DeprecatedInvalidWhitelistAccount,
    #[msg("Token not found in supported tokens list")]
    TokenNotFound,
    #[msg("Token must be disabled before removal")]
    TokenMustBeDisabled,
    #[msg("Vault must be empty before removing token")]
    VaultNotEmpty,
    #[msg("Pool has already been migrated to the role-based authority layout")]
    AlreadyMigrated,
    #[msg("Recipient key must not be the default pubkey")]
    RecipientNotSet,
    #[msg("Withdraw recipient is not on the allowlist")]
    WithdrawRecipientNotAllowed,
    #[msg("Withdraw recipient is already on the allowlist")]
    WithdrawRecipientAlreadyAllowed,
    #[msg("Maximum number of withdraw recipients reached")]
    MaxWithdrawRecipientsReached,
    #[msg("Legacy pool data length does not match the expected pre-migration size")]
    LegacySizeMismatch,
    #[msg("Legacy pool discriminator does not match LiquidityPool")]
    LegacyDiscriminatorMismatch,
    #[msg("Legacy supported_tokens length is invalid")]
    LegacyVecLengthInvalid,
    #[msg("Failed to serialize the new LiquidityPool layout during migration")]
    MigrationSerializeFailed,
    #[msg("Authority key must not be the default pubkey")]
    AuthorityNotSet,
    #[msg("Program data account does not belong to this program")]
    InvalidProgramData,
    #[msg("Payer is not the program upgrade authority")]
    NotUpgradeAuthority,
}
