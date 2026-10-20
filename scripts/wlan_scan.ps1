Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WlanTrigger {
    [DllImport("wlanapi.dll", SetLastError = true)]
    public static extern uint WlanOpenHandle(uint dwClientVersion, IntPtr pReserved, out uint pdwNegotiatedVersion, out IntPtr phClientHandle);

    [DllImport("wlanapi.dll", SetLastError = true)]
    public static extern uint WlanCloseHandle(IntPtr hClientHandle, IntPtr pReserved);

    [DllImport("wlanapi.dll", SetLastError = true)]
    public static extern uint WlanEnumInterfaces(IntPtr hClientHandle, IntPtr pReserved, out IntPtr ppInterfaceList);

    [DllImport("wlanapi.dll", SetLastError = true)]
    public static extern uint WlanScan(IntPtr hClientHandle, ref Guid pInterfaceGuid, IntPtr pDot11Ssid, IntPtr pIeData, IntPtr pReserved);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WLAN_INTERFACE_INFO {
        public Guid InterfaceGuid;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strInterfaceDescription;
        public int isState;
    }

    public static bool Trigger() {
        uint ver;
        IntPtr handle;
        try {
            if (WlanOpenHandle(2, IntPtr.Zero, out ver, out handle) == 0) {
                IntPtr pList;
                if (WlanEnumInterfaces(handle, IntPtr.Zero, out pList) == 0 && pList != IntPtr.Zero) {
                    int count = Marshal.ReadInt32(pList);
                    for (int i = 0; i < count; i++) {
                        IntPtr pEntry = new IntPtr(pList.ToInt64() + 8 + i * Marshal.SizeOf(typeof(WLAN_INTERFACE_INFO)));
                        WLAN_INTERFACE_INFO info = (WLAN_INTERFACE_INFO)Marshal.PtrToStructure(pEntry, typeof(WLAN_INTERFACE_INFO));
                        Guid g = info.InterfaceGuid;
                        WlanScan(handle, ref g, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                    }
                }
                WlanCloseHandle(handle, IntPtr.Zero);
                return true;
            }
        } catch { }
        return false;
    }
}
"@ -ErrorAction SilentlyContinue

[WlanTrigger]::Trigger() | Out-Null
