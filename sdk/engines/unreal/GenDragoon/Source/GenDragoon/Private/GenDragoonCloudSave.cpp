#include "GenDragoonCloudSave.h"

#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "GameFramework/SaveGame.h"
#include "GenDragoonApi.h"
#include "Kismet/GameplayStatics.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
	EGenDragoonStatus ToStatus(int Code) { return static_cast<EGenDragoonStatus>(FMath::Clamp(Code, 0, 9)); }

	/** Runs Work on a worker thread, then Then on the game thread. */
	template <typename TWork, typename TThen>
	void RunAsync(TWork&& Work, TThen&& Then)
	{
		Async(EAsyncExecution::ThreadPool, [Work = MoveTemp(Work), Then = MoveTemp(Then)]() mutable
		{
			auto Result = Work();
			AsyncTask(ENamedThreads::GameThread, [Then = MoveTemp(Then), Result = MoveTemp(Result)]() mutable { Then(MoveTemp(Result)); });
		});
	}

	struct FOutcome
	{
		EGenDragoonStatus Status = EGenDragoonStatus::Ok;
		FString Error;
		FString Text;
		TArray<uint8> Bytes;
	};

	FOutcome Missing()
	{
		FOutcome O;
		O.Status = EGenDragoonStatus::LibraryMissing;
		O.Error = TEXT("The GenDragoon library is not loaded.");
		return O;
	}
}

void UGenDragoonCloudSave::Deinitialize()
{
	ReleaseAll();
	Super::Deinitialize();
}

void UGenDragoonCloudSave::ReleaseAll()
{
	if (const FGenDragoonApi* Api = FGenDragoonApi::Get())
	{
		Api->Release(Drive);
		Api->Release(Keyring);
		Api->Release(Client);
	}
	Drive = Keyring = Client = 0;
}

void UGenDragoonCloudSave::Close() { ReleaseAll(); }

FString UGenDragoonCloudSave::SlotPath(const FString& Slot) const
{
	return SlotFolder.IsEmpty() ? Slot : SlotFolder + TEXT("/") + Slot;
}

void UGenDragoonCloudSave::Connect(const FString& ProviderUrl, const FString& ConnectCode, const FString& GameName, FGenDragoonConnected OnDone)
{
	const int32 Level = MaxLevel;
	RunAsync([ProviderUrl, ConnectCode, GameName, Level]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		char* Json = nullptr;
		char* Err = nullptr;
		O.Status = ToStatus(Api->ConnectGrant(TCHAR_TO_UTF8(*ProviderUrl), TCHAR_TO_UTF8(*ConnectCode.TrimStartAndEnd()), TCHAR_TO_UTF8(*GameName), Level, &Json, &Err));
		O.Error = Api->TakeString(Err);
		TSharedPtr<FJsonObject> Obj;
		if (O.Status == EGenDragoonStatus::Ok && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Api->TakeString(Json)), Obj) && Obj.IsValid())
		{
			O.Text = Obj->GetStringField(TEXT("apiKey"));
		}
		return O;
	}, [OnDone](FOutcome O) { OnDone.ExecuteIfBound(O.Status, O.Text, O.Error); });
}

EGenDragoonStatus UGenDragoonCloudSave::Open(const FString& ProviderUrl, const FString& ApiKey, FString& Error)
{
	const FGenDragoonApi* Api = FGenDragoonApi::Get();
	if (!Api)
	{
		Error = Missing().Error;
		return EGenDragoonStatus::LibraryMissing;
	}
	ReleaseAll();
	char* Err = nullptr;
	const EGenDragoonStatus S = ToStatus(Api->ClientNew(TCHAR_TO_UTF8(*ProviderUrl), TCHAR_TO_UTF8(*ApiKey), MaxLevel, &Client, &Err));
	Error = Api->TakeString(Err);
	return S;
}

void UGenDragoonCloudSave::Unlock(const FString& RecoveryPassphrase, bool bCreateIfMissing, FGenDragoonDone OnDone)
{
	const uint64 C = Client;
	const FString Name = DriveName;
	TWeakObjectPtr<UGenDragoonCloudSave> Self(this);
	struct FUnlocked { FOutcome O; uint64 Keyring = 0; uint64 Drive = 0; };
	RunAsync([C, Name, RecoveryPassphrase, bCreateIfMissing]()
	{
		FUnlocked R;
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) { R.O = Missing(); return R; }
		char* Err = nullptr;
		int Code = Api->KeyringUnlock(C, TCHAR_TO_UTF8(*RecoveryPassphrase), &R.Keyring, &Err);
		if (Code == GD_ERR_NOT_FOUND && bCreateIfMissing)
		{
			Api->Free(Err);
			Err = nullptr;
			Code = Api->KeyringCreate(C, TCHAR_TO_UTF8(*RecoveryPassphrase), &R.Keyring, &Err);
		}
		if (Code == GD_OK) Code = Api->DriveOpen(C, TCHAR_TO_UTF8(*Name), R.Keyring, &R.Drive, &Err);
		R.O.Status = ToStatus(Code);
		R.O.Error = Api->TakeString(Err);
		return R;
	}, [Self, OnDone](FUnlocked R)
	{
		if (Self.IsValid() && R.O.Status == EGenDragoonStatus::Ok)
		{
			Self->Keyring = R.Keyring;
			Self->Drive = R.Drive;
		}
		else if (const FGenDragoonApi* Api = FGenDragoonApi::Get())
		{
			Api->Release(R.Drive);
			Api->Release(R.Keyring);
		}
		OnDone.ExecuteIfBound(R.O.Status, R.O.Error);
	});
}

void UGenDragoonCloudSave::SaveSlot(const FString& Slot, const TArray<uint8>& Data, FGenDragoonDone OnDone)
{
	const uint64 D = Drive;
	const FString Path = SlotPath(Slot);
	RunAsync([D, Path, Data]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		char* Err = nullptr;
		O.Status = ToStatus(Api->DriveWrite(D, TCHAR_TO_UTF8(*Path), Data.GetData(), Data.Num(), &Err));
		O.Error = Api->TakeString(Err);
		return O;
	}, [OnDone](FOutcome O) { OnDone.ExecuteIfBound(O.Status, O.Error); });
}

void UGenDragoonCloudSave::LoadSlot(const FString& Slot, FGenDragoonData OnDone)
{
	const uint64 D = Drive;
	const FString Path = SlotPath(Slot);
	RunAsync([D, Path]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		uint8_t* Data = nullptr;
		size_t Len = 0;
		char* Err = nullptr;
		O.Status = ToStatus(Api->DriveRead(D, TCHAR_TO_UTF8(*Path), &Data, &Len, &Err));
		O.Error = Api->TakeString(Err);
		if (Data)
		{
			O.Bytes.Append(Data, static_cast<int32>(Len));
			Api->Free(Data);
		}
		return O;
	}, [OnDone](FOutcome O) { OnDone.ExecuteIfBound(O.Status, O.Bytes, O.Error); });
}

void UGenDragoonCloudSave::SaveGameObject(USaveGame* SaveGame, const FString& Slot, FGenDragoonDone OnDone)
{
	TArray<uint8> Bytes;
	if (SaveGame == nullptr || !UGameplayStatics::SaveGameToMemory(SaveGame, Bytes))
	{
		OnDone.ExecuteIfBound(EGenDragoonStatus::Invalid, TEXT("The SaveGame object could not be serialized."));
		return;
	}
	SaveSlot(Slot, Bytes, OnDone);
}

void UGenDragoonCloudSave::LoadGameObject(const FString& Slot, FGenDragoonSaveGame OnDone)
{
	const uint64 D = Drive;
	const FString Path = SlotPath(Slot);
	RunAsync([D, Path]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		uint8_t* Data = nullptr;
		size_t Len = 0;
		char* Err = nullptr;
		O.Status = ToStatus(Api->DriveRead(D, TCHAR_TO_UTF8(*Path), &Data, &Len, &Err));
		O.Error = Api->TakeString(Err);
		if (Data)
		{
			O.Bytes.Append(Data, static_cast<int32>(Len));
			Api->Free(Data);
		}
		return O;
	}, [OnDone](FOutcome O)
	{
		USaveGame* Loaded = O.Status == EGenDragoonStatus::Ok ? UGameplayStatics::LoadGameFromMemory(O.Bytes) : nullptr;
		if (O.Status == EGenDragoonStatus::Ok && Loaded == nullptr)
		{
			O.Status = EGenDragoonStatus::Invalid;
			O.Error = TEXT("The slot does not hold a SaveGame object.");
		}
		OnDone.ExecuteIfBound(O.Status, Loaded, O.Error);
	});
}

void UGenDragoonCloudSave::ListSlots(FGenDragoonSlots OnDone)
{
	const uint64 D = Drive;
	const FString Folder = SlotFolder;
	RunAsync([D, Folder]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		char* Json = nullptr;
		char* Err = nullptr;
		O.Status = ToStatus(Api->DriveList(D, TCHAR_TO_UTF8(*Folder), &Json, &Err));
		O.Error = Api->TakeString(Err);
		O.Text = Api->TakeString(Json);
		return O;
	}, [OnDone](FOutcome O)
	{
		TArray<FString> Slots;
		TArray<TSharedPtr<FJsonValue>> Items;
		if (O.Status == EGenDragoonStatus::Ok && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(O.Text), Items))
		{
			for (const TSharedPtr<FJsonValue>& V : Items)
			{
				const TSharedPtr<FJsonObject>* Obj;
				if (V->TryGetObject(Obj) && !(*Obj)->GetBoolField(TEXT("folder"))) Slots.Add((*Obj)->GetStringField(TEXT("name")));
			}
		}
		else if (O.Status == EGenDragoonStatus::NotFound)
		{
			O.Status = EGenDragoonStatus::Ok; // no saves yet
		}
		OnDone.ExecuteIfBound(O.Status, Slots, O.Error);
	});
}

void UGenDragoonCloudSave::DeleteSlot(const FString& Slot, FGenDragoonDone OnDone)
{
	const uint64 D = Drive;
	const FString Folder = SlotFolder;
	RunAsync([D, Folder, Slot]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		char* Err = nullptr;
		// Slot-scoped delete (files.deleteSlot, L2): only this slot file, never a folder or another path.
		O.Status = ToStatus(Api->DriveDeleteSlot(D, TCHAR_TO_UTF8(*Folder), TCHAR_TO_UTF8(*Slot), &Err));
		O.Error = Api->TakeString(Err);
		return O;
	}, [OnDone](FOutcome O) { OnDone.ExecuteIfBound(O.Status, O.Error); });
}

void UGenDragoonCloudSave::Usage(FGenDragoonUsage OnDone)
{
	const uint64 C = Client;
	RunAsync([C]()
	{
		const FGenDragoonApi* Api = FGenDragoonApi::Get();
		if (!Api) return Missing();
		FOutcome O;
		char* Json = nullptr;
		char* Err = nullptr;
		O.Status = ToStatus(Api->Usage(C, &Json, &Err));
		O.Error = Api->TakeString(Err);
		O.Text = Api->TakeString(Json);
		return O;
	}, [OnDone](FOutcome O)
	{
		int64 Used = 0, Quota = 0;
		TSharedPtr<FJsonObject> Obj;
		if (O.Status == EGenDragoonStatus::Ok && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(O.Text), Obj) && Obj.IsValid())
		{
			Used = static_cast<int64>(Obj->GetNumberField(TEXT("usedBytes")));
			Quota = static_cast<int64>(Obj->GetNumberField(TEXT("quotaBytes")));
		}
		OnDone.ExecuteIfBound(O.Status, Used, Quota, O.Error);
	});
}
