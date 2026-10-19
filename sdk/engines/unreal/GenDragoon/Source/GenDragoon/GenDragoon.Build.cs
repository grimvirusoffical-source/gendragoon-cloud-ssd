using System.IO;
using UnrealBuildTool;

public class GenDragoon : ModuleRules
{
	public GenDragoon(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "Json" });

		string Lib = Path.Combine(ModuleDirectory, "..", "ThirdParty", "GenDragoonLib");
		PublicIncludePaths.Add(Path.Combine(Lib, "include"));

		// The library is loaded at runtime (FPlatformProcess::GetDllHandle), so no import library is needed.
		string Name = Target.Platform == UnrealTargetPlatform.Win64 ? "gendragoon.dll"
			: Target.Platform == UnrealTargetPlatform.Mac ? "libgendragoon.dylib" : "libgendragoon.so";
		string Platform = Target.Platform.ToString();
		string Built = Path.Combine(Lib, "lib", Platform, Name);
		RuntimeDependencies.Add(Path.Combine("$(BinaryOutputDir)", Name), Built);
		PublicDefinitions.Add("GENDRAGOON_LIBRARY_NAME=TEXT(\"" + Name + "\")");
	}
}
