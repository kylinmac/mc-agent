// Compiled as a standalone GUI app by the Windows MCP smoke test.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class ComputerUseFixture : Form, IMessageFilter {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    readonly string path;
    readonly TextBox edit = new TextBox();
    readonly TextBox password = new TextBox();
    readonly CheckBox check = new CheckBox();
    readonly TreeNode parent;
    readonly Timer timer = new Timer();
    int clicks, wheel, drag;
    bool activated;

    public ComputerUseFixture(string statePath) {
        path = statePath;
        Text = "mc-agent Computer Use Test";
        AccessibleName = Text;
        StartPosition = FormStartPosition.Manual;
        Left = 150; Top = 150; Width = 640; Height = 480;
        edit.AccessibleName = "Test input";
        edit.SetBounds(30, 30, 400, 60);
        edit.Multiline = true; edit.Text = "initial";
        var button = new Button();
        button.Text = "Test button"; button.SetBounds(30, 110, 160, 35);
        button.Click += (s, e) => clicks++;
        check.Text = "Test checkbox"; check.SetBounds(30, 160, 180, 30);
        password.AccessibleName = "Test password";
        password.UseSystemPasswordChar = true;
        password.Text = "fixture-secret-do-not-expose";
        password.SetBounds(30, 210, 200, 30);
        var tree = new TreeView();
        tree.AccessibleName = "Test tree"; tree.SetBounds(280, 110, 250, 150);
        parent = tree.Nodes.Add("Expandable test node");
        parent.Nodes.Add("Child test node");
        Controls.AddRange(new Control[] { edit, button, check, password, tree });
        MouseUp += (s, e) => drag++;
        Application.AddMessageFilter(this);
        timer.Interval = 100;
        timer.Tick += (s, e) => Tick();
        Shown += (s, e) => {
            TopMost = true; timer.Start();
        };
    }
    void ActivateFixture() {
            // The fixture receives one normal title-bar click to establish the
            // interactive test precondition. Never click an unrelated window.
            TopMost = true;
            var at = new Point(Left + 100, Top + 15);
            if (GetAncestor(WindowFromPoint(at), 2) == Handle &&
                GetAsyncKeyState(1) >= 0 && GetAsyncKeyState(2) >= 0 &&
                GetAsyncKeyState(16) >= 0 && GetAsyncKeyState(17) >= 0 && GetAsyncKeyState(18) >= 0) {
                Cursor.Position = at;
                mouse_event(2, 0, 0, 0, UIntPtr.Zero);
                mouse_event(4, 0, 0, 0, UIntPtr.Zero);
                activated = true;
            }
            edit.Focus();
    }
    public bool PreFilterMessage(ref Message message) {
        if (message.Msg == 0x020A || message.Msg == 0x020E) wheel++;
        return false;
    }
    bool Command(string name) {
        string file = path + "." + name;
        if (!File.Exists(file)) return false;
        File.Delete(file); return true;
    }
    void Tick() {
        if (!activated) { ActivateFixture(); return; }
        TopMost = false;
        var state = new Dictionary<string, object> {
            { "pid", Process.GetCurrentProcess().Id }, { "text", edit.Text },
            { "clicks", clicks }, { "checked", check.Checked }, { "wheel", wheel },
            { "drag", drag }, { "expanded", parent.IsExpanded },
            { "left", Left }, { "top", Top }, { "width", Width }, { "height", Height },
            { "windowState", WindowState.ToString() }, { "passwordFocused", password.Focused },
            { "passwordUnchanged", password.Text == "fixture-secret-do-not-expose" }
        };
        File.WriteAllText(path, new JavaScriptSerializer().Serialize(state), new UTF8Encoding(false));
        if (Command("move")) Left += 30;
        if (Command("maximize")) WindowState = FormWindowState.Maximized;
        if (Command("restore")) WindowState = FormWindowState.Normal;
        if (Command("password")) password.Focus();
        if (Command("close")) Close();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { timer.Dispose(); Application.RemoveMessageFilter(this); }
        base.Dispose(disposing);
    }
    [STAThread]
    public static void Main(string[] args) {
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new ComputerUseFixture(args[0])) Application.Run(form);
    }
}
