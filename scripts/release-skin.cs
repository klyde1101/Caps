using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class Skin {
    internal static readonly Color Ground=Color.FromArgb(19,19,22),Surface=Color.FromArgb(27,27,31),Line=Color.FromArgb(44,44,50),
        Text=Color.FromArgb(236,236,239),Muted=Color.FromArgb(160,160,170),Accent=Color.FromArgb(157,140,255),
        OnAccent=Color.FromArgb(21,19,31),Success=Color.FromArgb(111,207,151);
    static readonly string Face=FindFace();
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action,uint parameter,out bool value,uint flags);
    internal static bool Motion {get{bool enabled;return !SystemParametersInfo(0x1042,0,out enabled,0)||enabled;}}
    static string FindFace() {foreach(FontFamily f in FontFamily.Families) if(f.Name=="Inter") return "Inter";return "Segoe UI";}
    internal static Font Font(float size,FontStyle style=FontStyle.Regular) {return new Font(Face,size,style,GraphicsUnit.Pixel);}
    internal static GraphicsPath Round(RectangleF r,float radius) {
        var p=new GraphicsPath();float d=radius*2;
        p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);
        p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
    }
}
sealed class SurfacePanel:Panel {
    internal SurfacePanel() {DoubleBuffered=true;BackColor=Skin.Ground;}
    protected override void OnPaintBackground(PaintEventArgs e) {
        e.Graphics.Clear(Skin.Ground);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
        using(var p=Skin.Round(new RectangleF(0,0,Width-1,Height-1),12))
        using(var b=new SolidBrush(Skin.Surface)) e.Graphics.FillPath(b,p);
    }
}
sealed class CapsButton:Button {
    readonly bool primary;bool hovered;
    internal CapsButton(bool main) {
        primary=main;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;Font=Skin.Font(14,FontStyle.Bold);Cursor=Cursors.Hand;
        SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);
    }
    protected override void OnMouseEnter(EventArgs e) {hovered=true;Invalidate();base.OnMouseEnter(e);}
    protected override void OnMouseLeave(EventArgs e) {hovered=false;Invalidate();base.OnMouseLeave(e);}
    protected override void OnGotFocus(EventArgs e) {base.OnGotFocus(e);Invalidate();}
    protected override void OnLostFocus(EventArgs e) {base.OnLostFocus(e);Invalidate();}
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.Clear(Parent.BackColor);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
        Color fill=!Enabled?Skin.Line:primary?Skin.Accent:hovered?Color.FromArgb(44,44,50):Skin.Surface;
        using(var p=Skin.Round(new RectangleF(1,1,Width-3,Height-3),10))
        using(var b=new SolidBrush(fill)) e.Graphics.FillPath(b,p);
        TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,!Enabled?Skin.Muted:primary?Skin.OnAccent:Skin.Text,
            TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix);
        if(Focused && ShowFocusCues)
            using(var pen=new Pen(Skin.Text,1)) using(var p=Skin.Round(new RectangleF(4,4,Width-9,Height-9),7)) e.Graphics.DrawPath(pen,p);
    }
}
sealed class CapsProgress:Control {
    readonly System.Windows.Forms.Timer timer;double target,shown;float phase;bool active;
    internal bool Indeterminate;
    internal bool Active {get{return active;}set{active=value;timer.Enabled=value;if(!value){shown=target;Invalidate();}}}
    internal double Value {get{return target;}set{
        double before=target;target=Math.Max(0,Math.Min(1,value));
        if(!active)shown=target;
        if(Math.Floor(before*100)!=Math.Floor(target*100))AccessibilityNotifyClients(AccessibleEvents.ValueChange,-1);
        Invalidate();
    }}
    internal void Reset() {shown=target=0;}
    protected override AccessibleObject CreateAccessibilityInstance() {return new ProgressAccessibility(this);}
    sealed class ProgressAccessibility:Control.ControlAccessibleObject {
        readonly CapsProgress owner;
        internal ProgressAccessibility(CapsProgress control):base(control){owner=control;}
        public override string Value {get{return owner.Indeterminate?"In progress":Math.Floor(owner.Value*100).ToString(CultureInfo.InvariantCulture)+"%";}set{}}
        public override AccessibleStates State {get{return base.State|AccessibleStates.ReadOnly;}}
    }
    internal CapsProgress() {
        SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);
        AccessibleName="Installation progress";AccessibleRole=AccessibleRole.ProgressBar;
        timer=new System.Windows.Forms.Timer {Interval=16};
        timer.Tick+=(s,e)=>{bool motion=Skin.Motion;shown=motion&&Active?shown+(target-shown)*.16:target;
            if(motion&&Active) phase=(phase+.012f)%1;Invalidate();};
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.Clear(Skin.Surface);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float h=Height-1;
        using(var p=Skin.Round(new RectangleF(0,0,Width-1,h),h/2)) using(var b=new SolidBrush(Skin.Line)) e.Graphics.FillPath(b,p);
        float w=Indeterminate?Width*.22f:(float)(shown*Width);if(w<1)return;
        float x=Indeterminate&&Skin.Motion?(Width+w)*phase-w:0;
        e.Graphics.SetClip(ClientRectangle);
        using(var p=Skin.Round(new RectangleF(x,0,Math.Max(h,w),h),h/2)) using(var b=new SolidBrush(Skin.Accent)) e.Graphics.FillPath(b,p);
        if(!Indeterminate&&Active&&Skin.Motion) {
            e.Graphics.SetClip(new RectangleF(0,0,w,h));using(var b=new SolidBrush(Color.FromArgb(200,190,255)))e.Graphics.FillRectangle(b,w*phase-24,0,24,h);
        }
        e.Graphics.ResetClip();
    }
    protected override void Dispose(bool disposing) {if(disposing)timer.Dispose();base.Dispose(disposing);}
}
