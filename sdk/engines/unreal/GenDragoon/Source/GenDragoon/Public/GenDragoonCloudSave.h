// Encrypted cloud save slots for one GenDragoon binding.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GenDragoonCloudSave.generated.h"

class USaveGame;

/** Result codes; values match GD_* in gendragoon.h. */
UENUM(BlueprintType)
enum class EGenDragoonStatus : uint8
{
	Ok = 0,
	LevelRefused = 1,
	NotFound = 2,
	Conflict = 3,
	QuotaExceeded = 4,
	Unauthorized = 5,
	WrongPassphrase = 6,
	Invalid = 7,
	RateLimited = 8,
	Failed = 9,
	LibraryMissing = 255,
};

DECLARE_DYNAMIC_DELEGATE_TwoParams(FGenDragoonDone, EGenDragoonStatus, Status, const FString&, Error);
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FGenDragoonConnected, EGenDragoonStatus, Status, const FString&, ApiKey, const FString&, Error);
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FGenDragoonData, EGenDragoonStatus, Status, const TArray<uint8>&, Data, const FString&, Error);
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FGenDragoonSaveGame, EGenDragoonStatus, Status, USaveGame*, SaveGame, const FString&, Error);
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FGenDragoonSlots, EGenDragoonStatus, Status, const TArray<FString>&, Slots, const FString&, Error);
DECLARE_DYNAMIC_DELEGATE_FourParams(FGenDragoonUsage, EGenDragoonStatus, Status, int64, UsedBytes, int64, QuotaBytes, const FString&, Error);

/**
 * Cloud saves on GenDragoon Cloud SSD. Connect once with a connect code the player copies from GenDragoon, keep the
 * returned API key (it identifies this game's binding), then Open and Unlock at each start. Slots are encrypted on
 * the device with the player's master key; GenDragoon never sees their contents.
 *
 * Every call runs on a worker thread and reports back on the game thread. MaxLevel caps the Rotten Apple level of
 * the calls this subsystem makes; cloud saves need L2, which is the default.
 */
UCLASS()
class GENDRAGOON_API UGenDragoonCloudSave : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Highest operation level this subsystem may use (0-4). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "GenDragoon")
	int32 MaxLevel = 2;

	/** Name of the encrypted drive that holds this game's saves. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "GenDragoon")
	FString DriveName = TEXT("cloud-save");

	/** Folder inside the drive that holds the slots. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "GenDragoon")
	FString SlotFolder = TEXT("saves");

	virtual void Deinitialize() override;

	/** Redeems a one-time connect code. Store the API key securely; it is shown only here. Level L2, risk credential. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void Connect(const FString& ProviderUrl, const FString& ConnectCode, const FString& GameName, FGenDragoonConnected OnDone);

	/** Uses a stored API key for this session. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	EGenDragoonStatus Open(const FString& ProviderUrl, const FString& ApiKey, FString& Error);

	/** Opens the player's master key, creating it on first use when bCreateIfMissing (keyEnvelope.create, L2, only
	 * when the binding has no key yet). Level L2, risk key. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void Unlock(const FString& RecoveryPassphrase, bool bCreateIfMissing, FGenDragoonDone OnDone);

	UFUNCTION(BlueprintPure, Category = "GenDragoon")
	bool IsUnlocked() const { return Drive != 0; }

	/** Drops the master key from memory and closes the session. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void Close();

	/** Level L2, risk write. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void SaveSlot(const FString& Slot, const TArray<uint8>& Data, FGenDragoonDone OnDone);

	/** Level L2, risk read. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void LoadSlot(const FString& Slot, FGenDragoonData OnDone);

	/** Serializes a SaveGame object (UGameplayStatics::SaveGameToMemory) into a slot. Level L2, risk write. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void SaveGameObject(USaveGame* SaveGame, const FString& Slot, FGenDragoonDone OnDone);

	/** Level L2, risk read. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void LoadGameObject(const FString& Slot, FGenDragoonSaveGame OnDone);

	/** Level L2, risk read. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void ListSlots(FGenDragoonSlots OnDone);

	/** Deletes one slot with the slot-scoped delete (files.deleteSlot): it can only remove SlotFolder/Slot. Level L2, risk destructive. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void DeleteSlot(const FString& Slot, FGenDragoonDone OnDone);

	/** Storage used by this game's binding. Level L2, risk read. */
	UFUNCTION(BlueprintCallable, Category = "GenDragoon")
	void Usage(FGenDragoonUsage OnDone);

private:
	uint64 Client = 0;
	uint64 Keyring = 0;
	uint64 Drive = 0;

	FString SlotPath(const FString& Slot) const;
	void ReleaseAll();
};
