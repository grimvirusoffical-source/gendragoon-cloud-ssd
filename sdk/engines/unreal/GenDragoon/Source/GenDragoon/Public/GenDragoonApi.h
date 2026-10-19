// Function table for libgendragoon, resolved when the module starts.
#pragma once

#include "CoreMinimal.h"
#include "gendragoon.h"

struct GENDRAGOON_API FGenDragoonApi
{
	decltype(&gd_version) Version = nullptr;
	decltype(&gd_free) Free = nullptr;
	decltype(&gd_release) Release = nullptr;
	decltype(&gd_connect_grant) ConnectGrant = nullptr;
	decltype(&gd_client_new) ClientNew = nullptr;
	decltype(&gd_usage) Usage = nullptr;
	decltype(&gd_keyring_unlock) KeyringUnlock = nullptr;
	decltype(&gd_keyring_create) KeyringCreate = nullptr;
	decltype(&gd_drive_open) DriveOpen = nullptr;
	decltype(&gd_drive_list) DriveList = nullptr;
	decltype(&gd_drive_read) DriveRead = nullptr;
	decltype(&gd_drive_write) DriveWrite = nullptr;
	decltype(&gd_drive_delete) DriveDelete = nullptr;

	bool IsLoaded() const { return Version != nullptr; }

	/** The loaded library, or nullptr when it could not be loaded (see the log). */
	static const FGenDragoonApi* Get();

	/** Takes a string returned by the library and frees it. */
	FString TakeString(char* S) const
	{
		if (S == nullptr) return FString();
		FString Out = UTF8_TO_TCHAR(S);
		Free(S);
		return Out;
	}
};
