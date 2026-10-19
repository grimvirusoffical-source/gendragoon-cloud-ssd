#include "GenDragoonApi.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogGenDragoon, Log, All);

static FGenDragoonApi GApi;
static void* GHandle = nullptr;

const FGenDragoonApi* FGenDragoonApi::Get()
{
	return GApi.IsLoaded() ? &GApi : nullptr;
}

class FGenDragoonModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		const FString Path = FPaths::Combine(FPlatformProcess::GetModulesDirectory(), GENDRAGOON_LIBRARY_NAME);
		GHandle = FPlatformProcess::GetDllHandle(*Path);
		if (GHandle == nullptr)
		{
			UE_LOG(LogGenDragoon, Error, TEXT("Could not load %s; cloud saves are unavailable."), *Path);
			return;
		}
		FGenDragoonApi Api;
		bool bOk = true;
		auto Bind = [&](auto& Fn, const TCHAR* Name)
		{
			Fn = reinterpret_cast<std::remove_reference_t<decltype(Fn)>>(FPlatformProcess::GetDllExport(GHandle, Name));
			bOk &= Fn != nullptr;
		};
		Bind(Api.Version, TEXT("gd_version"));
		Bind(Api.Free, TEXT("gd_free"));
		Bind(Api.Release, TEXT("gd_release"));
		Bind(Api.ConnectGrant, TEXT("gd_connect_grant"));
		Bind(Api.ClientNew, TEXT("gd_client_new"));
		Bind(Api.Usage, TEXT("gd_usage"));
		Bind(Api.KeyringUnlock, TEXT("gd_keyring_unlock"));
		Bind(Api.KeyringCreate, TEXT("gd_keyring_create"));
		Bind(Api.DriveOpen, TEXT("gd_drive_open"));
		Bind(Api.DriveList, TEXT("gd_drive_list"));
		Bind(Api.DriveRead, TEXT("gd_drive_read"));
		Bind(Api.DriveWrite, TEXT("gd_drive_write"));
		Bind(Api.DriveDelete, TEXT("gd_drive_delete"));
		if (!bOk)
		{
			UE_LOG(LogGenDragoon, Error, TEXT("%s is missing exports; rebuild it from sdk/go/cabi."), *Path);
			return;
		}
		GApi = Api;
		UE_LOG(LogGenDragoon, Log, TEXT("GenDragoon library %s loaded."), UTF8_TO_TCHAR(GApi.Version()));
	}

	virtual void ShutdownModule() override
	{
		GApi = FGenDragoonApi();
		if (GHandle != nullptr)
		{
			FPlatformProcess::FreeDllHandle(GHandle);
			GHandle = nullptr;
		}
	}
};

IMPLEMENT_MODULE(FGenDragoonModule, GenDragoon)
