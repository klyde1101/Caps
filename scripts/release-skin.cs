using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// A read-only manifest scan may reuse parent checks. Deletion always uses a fresh walk.
static class InstalledPathCheck {
    internal static void Validate(string path, HashSet<string> visited = null) {
        for (string part = path; part != null; part = Path.GetDirectoryName(part)) {
            if (visited != null && !visited.Add(part)) break;
            FileAttributes attributes;
            try { attributes = File.GetAttributes(part); }
            catch (FileNotFoundException) { continue; }
            catch (DirectoryNotFoundException) { continue; }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("A linked installation path prevents this operation: " + part);
        }
    }
}

static class Skin {
    internal static readonly Color Ground=Color.FromArgb(32,32,32),Surface=Color.FromArgb(43,43,43),Line=Color.FromArgb(58,58,58),
        Text=Color.White,Muted=Color.FromArgb(180,180,192),Accent=Color.FromArgb(148,132,255),
        OnAccent=Color.FromArgb(20,20,20),Error=Color.FromArgb(244,151,157),Stats=Color.FromArgb(196,196,208);
    static readonly string Face=FindFace();
    static readonly string StrongFace=FindStrongFace();
    static readonly Dictionary<string,Bitmap> Images=new Dictionary<string,Bitmap>();
    internal static bool? MotionOverride; // Preview/test override; production follows Windows accessibility settings.
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action,uint parameter,out bool value,uint flags);
    internal static bool Motion {get{if(MotionOverride.HasValue)return MotionOverride.Value;bool enabled;return !SystemParametersInfo(0x1042,0,out enabled,0)||enabled;}}
    static string FindFace(){foreach(FontFamily f in FontFamily.Families)if(f.Name=="Segoe UI Variable Text")return f.Name;return "Segoe UI";}
    static string FindStrongFace(){foreach(FontFamily f in FontFamily.Families)if(f.Name=="Segoe UI Semibold")return f.Name;return Face;}
    internal static Font Font(float size,FontStyle style=FontStyle.Regular){return new Font(style==FontStyle.Bold?StrongFace:Face,size*72f/96f,style==FontStyle.Bold&&StrongFace!=Face?FontStyle.Regular:style,GraphicsUnit.Point);}
    internal static GraphicsPath Round(RectangleF r,float radius){var p=new GraphicsPath();float d=radius*2;
        p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;}
    internal static Bitmap Image(string name){
        Bitmap cached;if(Images.TryGetValue(name,out cached))return new Bitmap(cached);
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(name))using(var source=new Bitmap(stream)){
            int left=source.Width,top=source.Height,right=0,bottom=0;
            for(int y=0;y<source.Height;y++)for(int x=0;x<source.Width;x++)if(source.GetPixel(x,y).A>0){left=Math.Min(left,x);top=Math.Min(top,y);right=Math.Max(right,x+1);bottom=Math.Max(bottom,y+1);}
            var result=source.Clone(Rectangle.FromLTRB(left,top,right,bottom),System.Drawing.Imaging.PixelFormat.Format32bppArgb);Images.Add(name,new Bitmap(result));return result;
        }
    }
    internal static CapsButton RepositoryButton(){
        var button=new CapsButton(false){Text=InstallerIdentity.Publisher,Font=Font(14),TabIndex=2,Quiet=true,Image=Image("github-mark.png"),
            AccessibleName=InstallerIdentity.Publisher+" on GitHub",AccessibleDescription="Opens the Caps repository in your default browser."};
        button.Disposed+=(s,e)=>button.Image.Dispose();
        button.Click+=(s,e)=>{try{Process.Start(new ProcessStartInfo(InstallerIdentity.Url){UseShellExecute=true});}
            catch(Win32Exception){MessageBox.Show(button.FindForm(),"Open "+InstallerIdentity.Url+" in your browser.","Caps on GitHub",MessageBoxButtons.OK,MessageBoxIcon.Information);}};
        return button;
    }
}

// Both production windows and their previews use this exact shell and layout.
class SetupWindow:Form {
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,int message,IntPtr wParam,IntPtr lParam);
    readonly Bitmap titleIcon;
    readonly CaptionButton minimize,maximize,close;
    bool updatingChrome;
    internal float LayoutScale {get{return ClientSize.Width/760f;}}
    protected SetupWindow(string title){
        Text=title;AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;ClientSize=new Size(760,640);
        BackColor=Skin.Ground;ForeColor=Skin.Text;Font=Skin.Font(14);FormBorderStyle=FormBorderStyle.None;
        MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;DoubleBuffered=true;
        Icon=Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);titleIcon=Skin.Image("caps-icon.png");
        minimize=new CaptionButton(0){AccessibleName="Minimize"};maximize=new CaptionButton(1){AccessibleName="Maximize",Enabled=false};close=new CaptionButton(2){AccessibleName="Close"};
        Controls.AddRange(new Control[]{minimize,maximize,close});
        minimize.Click+=(s,e)=>WindowState=FormWindowState.Minimized;close.Click+=(s,e)=>Close();
        Resize+=(s,e)=>UpdateChrome();UpdateChrome();
    }
    protected override void OnLayout(LayoutEventArgs e){base.OnLayout(e);UpdateChrome();}
    void UpdateChrome(){float scale=LayoutScale;if(scale<=0||updatingChrome)return;updatingChrome=true;
        if(minimize!=null){int w=(int)Math.Round(46*scale),h=(int)Math.Round(40*scale),edge=(int)Math.Ceiling(scale);
            close.Bounds=new Rectangle(ClientSize.Width-edge-w,edge,w,h-edge);maximize.Bounds=new Rectangle(close.Left-w,edge,w,h-edge);minimize.Bounds=new Rectangle(maximize.Left-w,edge,w,h-edge);}
        using(var path=Skin.Round(new RectangleF(0,0,ClientSize.Width,ClientSize.Height),10*scale)) {var old=Region;Region=new Region(path);if(old!=null)old.Dispose();}Invalidate();updatingChrome=false;
    }
    protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);if(e.Button==MouseButtons.Left&&e.Y<40*LayoutScale){ReleaseCapture();SendMessage(Handle,0xA1,new IntPtr(2),IntPtr.Zero);}}
    protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);float scale=LayoutScale;if(scale<=0)return;
        e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
        using(var b=new SolidBrush(Color.FromArgb(27,27,27)))e.Graphics.FillRectangle(b,0,0,Width,40*scale);
        if(titleIcon!=null)e.Graphics.DrawImage(titleIcon,new RectangleF(14*scale,12*scale,16*scale,16*scale));
        using(var f=Skin.Font(13*scale*96/e.Graphics.DpiX))TextRenderer.DrawText(e.Graphics,Text,f,new Rectangle((int)(40*scale),0,(int)(400*scale),(int)(40*scale)),Color.FromArgb(208,208,216),TextFormatFlags.NoPadding|TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine);
        using(var p=Skin.Round(new RectangleF(scale/2,scale/2,Width-scale,Height-scale),10*scale))using(var pen=new Pen(Skin.Line,scale))e.Graphics.DrawPath(pen,p);
        foreach(Control control in Controls){var button=control as CapsButton;if(button!=null&&button.KeyboardFocused){
            var r=button.Bounds;r.Inflate((int)(3*scale),(int)(3*scale));using(var p=Skin.Round(r,8*scale))using(var pen=new Pen(Skin.Accent,2*scale))e.Graphics.DrawPath(pen,p);}}
    }
    protected override void OnShown(EventArgs e){base.OnShown(e);ActiveControl=null;}
    protected override void Dispose(bool disposing){if(disposing&&titleIcon!=null)titleIcon.Dispose();base.Dispose(disposing);}
}
sealed class CaptionButton:Button {
    readonly int kind;bool hover;
    internal CaptionButton(int value){kind=value;TabStop=false;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}
    protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
    protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
    protected override void OnPaint(PaintEventArgs e){float scale=Width/46f;
        e.Graphics.Clear(Enabled&&hover?(kind==2?Color.FromArgb(196,43,28):Color.FromArgb(46,46,46)):Color.FromArgb(27,27,27));
        e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float x=Width/2f,y=Height/2f;
        using(var pen=new Pen(!Enabled?Color.FromArgb(108,108,118):hover&&kind==2?Color.White:Color.FromArgb(208,208,216),scale)){
            if(kind==0)e.Graphics.DrawLine(pen,x-5*scale,y,x+5*scale,y);
            else if(kind==1)e.Graphics.DrawRectangle(pen,x-4.5f*scale,y-4.5f*scale,9*scale,9*scale);
            else {e.Graphics.DrawLine(pen,x-4.5f*scale,y-4.5f*scale,x+4.5f*scale,y+4.5f*scale);e.Graphics.DrawLine(pen,x+4.5f*scale,y-4.5f*scale,x-4.5f*scale,y+4.5f*scale);}
        }
    }
}
sealed class AlignedLabel:Label {
    internal int LineHeight;
    internal AlignedLabel(){AutoSize=false;UseMnemonic=false;TabStop=false;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}
    protected override void OnPaint(PaintEventArgs e){
        var flags=TextFormatFlags.NoPadding|TextFormatFlags.NoPrefix|TextFormatFlags.WordBreak;
        if(LineHeight>0){float scale=FindForm().ClientSize.Width/760f;int y=0;
            foreach(string paragraph in Text.Split('\n')){string line="";
                foreach(string word in paragraph.Split(' ')){string next=line.Length==0?word:line+" "+word;
                    if(line.Length>0&&TextRenderer.MeasureText(e.Graphics,next,Font,Size.Empty,TextFormatFlags.NoPadding|TextFormatFlags.SingleLine).Width>Width){TextRenderer.DrawText(e.Graphics,line,Font,new Point(0,y),ForeColor,TextFormatFlags.NoPadding|TextFormatFlags.NoPrefix);y+=(int)(LineHeight*scale);line=word;}else line=next;}
                TextRenderer.DrawText(e.Graphics,line,Font,new Point(0,y),ForeColor,TextFormatFlags.NoPadding|TextFormatFlags.NoPrefix);y+=(int)(LineHeight*scale);
            }return;
        }
        if(TextAlign==ContentAlignment.MiddleRight)flags|=TextFormatFlags.Right|TextFormatFlags.VerticalCenter;
        TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,ForeColor,flags);
    }
}
sealed class SetupLayout:Component {
    internal readonly PictureBox Logo;
    internal readonly Label Heading,Description,Note,Stage,Part,Percent,Detail,Rate;
    internal readonly SetupSteps Steps;
    internal readonly SurfacePanel Card;
    internal readonly TextBox Folder,ErrorDetails;
    internal readonly CapsProgress Progress;
    internal readonly CapsButton Primary,Secondary,Repository;
    internal readonly LinkLabel DetailsLink;
    internal readonly VersionPill Version;
    static Label AddLabel(Control parent,string text,int x,int y,int w,int h,float size,Color color,FontStyle style){
        var label=new AlignedLabel{Text=text,Bounds=new Rectangle(x,y,w,h),Font=Skin.Font(size,style),ForeColor=color,BackColor=parent is SurfacePanel?Skin.Surface:Skin.Ground};parent.Controls.Add(label);return label;
    }
    internal SetupLayout(SetupWindow window,bool removal,string directory,string downloadSize){
        Logo=new PictureBox{Bounds=new Rectangle(48,76,52,52),Image=Skin.Image("caps-icon.png"),SizeMode=PictureBoxSizeMode.Zoom,TabStop=false};window.Controls.Add(Logo);Logo.Disposed+=(s,e)=>Logo.Image.Dispose();
        AddLabel(window,"Caps",116,73,260,32,24,Skin.Text,FontStyle.Bold);
        AddLabel(window,removal?"Uninstall for Windows":"Setup for Windows",116,106,280,24,15,Skin.Muted,FontStyle.Regular);
        Version=new VersionPill{Text="Version "+InstallerIdentity.Version,Bounds=new Rectangle(520,85,192,34)};window.Controls.Add(Version);
        Heading=AddLabel(window,removal?"Uninstall Caps?":"Install Caps",48,164,664,34,28,Skin.Text,FontStyle.Bold);
        Description=AddLabel(window,removal?"This removes Caps and its CPU and GPU speech tools from your PC.\nClose Caps before you continue.":"Caps makes captions right on your PC. Setup downloads the CPU and GPU speech tools you need to get started.",48,206,560,48,16,Skin.Muted,FontStyle.Regular);
        ((AlignedLabel)Description).LineHeight=24;
        Steps=new SetupSteps{Bounds=new Rectangle(38,272,684,48)};if(removal)Steps.Labels=new[]{"Check files","Remove app","Done"};window.Controls.Add(Steps);
        Card=new SurfacePanel{Bounds=new Rectangle(48,334,664,156)};window.Controls.Add(Card);
        Stage=AddLabel(Card,"Installation folder",24,20,484,26,16,Skin.Text,FontStyle.Bold);
        Part=AddLabel(Card,"",24,47,484,24,14,Skin.Muted,FontStyle.Regular);
        Percent=AddLabel(Card,"",524,20,116,48,32,Skin.Text,FontStyle.Bold);Percent.TextAlign=ContentAlignment.MiddleRight;
        Folder=new TextBox{Bounds=new Rectangle(24,58,616,24),Text=directory,BorderStyle=BorderStyle.None,BackColor=Skin.Surface,ForeColor=Skin.Text,Font=Skin.Font(14),ReadOnly=true,AccessibleName="Installation folder",TabIndex=3};Card.Controls.Add(Folder);
        Progress=new CapsProgress{Bounds=new Rectangle(24,72,616,38),Visible=false,AccessibleName=removal?"Uninstall progress":"Installation progress"};Card.Controls.Add(Progress);
        Detail=AddLabel(Card,removal?"":downloadSize+" download",24,112,250,24,14,Skin.Stats,FontStyle.Regular);
        Rate=AddLabel(Card,"",274,112,366,24,14,Skin.Stats,FontStyle.Regular);Rate.TextAlign=ContentAlignment.MiddleRight;
        ErrorDetails=new TextBox{Bounds=new Rectangle(24,47,616,44),Multiline=true,ReadOnly=true,BorderStyle=BorderStyle.None,BackColor=Skin.Surface,ForeColor=Skin.Text,Font=Skin.Font(14),ScrollBars=ScrollBars.Vertical,Visible=false,AccessibleName=removal?"Uninstall error details":"Installation error details"};Card.Controls.Add(ErrorDetails);
        Note=AddLabel(window,removal?"Your settings, downloaded models, and caption files are kept.":"ⓘ  No administrator access needed. Allow at least 12 GB of free space.",48,506,664,28,14,Skin.Muted,FontStyle.Regular);
        DetailsLink=new LinkLabel{Bounds=new Rectangle(48,506,200,28),Text="Show details",Font=Skin.Font(14),LinkColor=Skin.Text,ActiveLinkColor=Skin.Accent,VisitedLinkColor=Skin.Text,Visible=false,TabIndex=4};window.Controls.Add(DetailsLink);
        window.Controls.Add(new Panel{Bounds=new Rectangle(48,551,664,1),BackColor=Color.FromArgb(51,51,51),TabStop=false});
        Repository=Skin.RepositoryButton();Repository.Bounds=new Rectangle(48,568,152,44);window.Controls.Add(Repository);
        Secondary=new CapsButton(false){Bounds=new Rectangle(430,568,120,44),Text="Cancel",TabIndex=0};Primary=new CapsButton(true){Bounds=new Rectangle(562,568,150,44),Text=removal?"Uninstall Caps":"Install Caps",TabIndex=1};
        window.Controls.Add(Secondary);window.Controls.Add(Primary);
    }
}
sealed class VersionPill:Control {
    internal VersionPill(){Font=Skin.Font(14);ForeColor=Skin.Muted;TabStop=false;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}
    protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(Skin.Ground);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
        using(var p=Skin.Round(new RectangleF(.5f,.5f,Width-1,Height-1),(Height-1)/2))using(var pen=new Pen(Skin.Line))e.Graphics.DrawPath(pen,p);
        TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Skin.Muted,TextFormatFlags.NoPadding|TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix);}
}
sealed class SetupSteps:Control {
    internal string[] Labels=new[]{"Download","Check files","Install"};
    int current=-1;readonly Stopwatch clock=Stopwatch.StartNew();readonly Timer timer;
    internal bool DownloadArrow=true;
    internal int Current{get{return current;}set{current=value;AccessibleName=string.Join(", ",Labels)+"; "+(value>=Labels.Length?"complete":value<0?"ready":Labels[value]);timer.Enabled=value>=0&&value<Labels.Length;Invalidate();}}
    internal SetupSteps(){Font=Skin.Font(15);TabStop=false;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);timer=new Timer{Interval=32};timer.Tick+=(s,e)=>{if(Skin.Motion)Invalidate();};}
    internal float Inset {get{return (float)Math.Floor(Height*10f/48);}}
    internal float ConnectorWidth {get{float s=Height/48f;return (Width-20*s-3*138*s-64*s)/2;}}
    protected override void OnPaint(PaintEventArgs e){
        e.Graphics.Clear(Skin.Ground);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float s=Height/48f,group=138*s,line=ConnectorWidth;double seconds=clock.Elapsed.TotalSeconds;
        var original=e.Graphics.Save();e.Graphics.TranslateTransform(0,10*s);
        using(var normal=Skin.Font(15*s*96/e.Graphics.DpiX))using(var bold=Skin.Font(15*s*96/e.Graphics.DpiX,FontStyle.Bold))
        for(int i=0;i<3;i++){
            float x=Inset+i*(group+line+32*s);bool done=current>i,active=current==i;
            if(i<2){float start=x+group+16*s,end=start+line;
                using(var pen=new Pen(done?Skin.Accent:Color.FromArgb(64,64,64),2*s))e.Graphics.DrawLine(pen,start,14*s,end,14*s);
                if(active){var state=e.Graphics.Save();e.Graphics.SetClip(new RectangleF(start,0,line,28*s));float lead=Skin.Motion?start-line+(float)(seconds/2.2%1)*line*2:start;
                    using(var b=new LinearGradientBrush(new RectangleF(lead,13*s,line,2*s),Color.Transparent,Skin.Accent,0f)){
                        b.InterpolationColors=new ColorBlend{Colors=new[]{Color.FromArgb(0,Skin.Accent),Skin.Accent,Color.FromArgb(0,Skin.Accent)},Positions=new[]{0f,.5f,1f}};e.Graphics.FillRectangle(b,lead,13*s,line,2*s);}e.Graphics.Restore(state);}
            }
            var circle=new RectangleF(x,0,28*s,28*s);
            if(active||done)using(var b=new SolidBrush(Skin.Accent))e.Graphics.FillEllipse(b,circle);
            else using(var pen=new Pen(Color.FromArgb(90,90,100),2*s))e.Graphics.DrawEllipse(pen,x+s,s,26*s,26*s);
            if(active&&Skin.Motion){float spread=(float)(seconds/2%1)*10*s;using(var pen=new Pen(Color.FromArgb((int)(100*(1-spread/(10*s))),Skin.Accent),s))e.Graphics.DrawEllipse(pen,x-spread,-spread,28*s+spread*2,28*s+spread*2);}
            if(done)using(var pen=new Pen(Skin.OnAccent,2*s))e.Graphics.DrawLines(pen,new[]{new PointF(x+8*s,14*s),new PointF(x+12*s,18*s),new PointF(x+20*s,9*s)});
            else if(active&&i==0&&DownloadArrow){float y=14*s+(Skin.Motion?(float)Math.Sin(seconds*Math.PI*2/1.2)*1.5f*s:0);
                using(var pen=new Pen(Skin.OnAccent,2*s)){e.Graphics.DrawLine(pen,x+14*s,y-7*s,x+14*s,y+5*s);e.Graphics.DrawLines(pen,new[]{new PointF(x+9*s,y),new PointF(x+14*s,y+5*s),new PointF(x+19*s,y)});}}
            else using(var b=new SolidBrush(active?Skin.OnAccent:Skin.Muted))using(var format=new StringFormat(StringFormat.GenericTypographic){Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center})e.Graphics.DrawString((i+1).ToString(),normal,b,circle,format);
            using(var b=new SolidBrush(active||done?Skin.Text:Skin.Muted))using(var format=new StringFormat(StringFormat.GenericTypographic){LineAlignment=StringAlignment.Center,FormatFlags=StringFormatFlags.NoWrap})e.Graphics.DrawString(Labels[i],active?bold:normal,b,new RectangleF(x+38*s,0,100*s,28*s),format);
        }
        e.Graphics.Restore(original);
    }
    protected override void Dispose(bool disposing){if(disposing)timer.Dispose();base.Dispose(disposing);}
}
sealed class SurfacePanel:Panel {
    internal SurfacePanel(){DoubleBuffered=true;BackColor=Skin.Ground;TabStop=false;}
    protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(Skin.Ground);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float s=Width/664f;
        using(var p=Skin.Round(new RectangleF(.5f*s,.5f*s,Width-s,Height-s),8*s)){using(var b=new SolidBrush(Skin.Surface))e.Graphics.FillPath(b,p);using(var pen=new Pen(Skin.Line,s))e.Graphics.DrawPath(pen,p);}}
}
sealed class CapsButton:Button {
    readonly bool primary;bool hovered,pressed,mouseFocus;
    internal bool Quiet;
    internal bool KeyboardFocused{get{return Focused&&ShowFocusCues&&!mouseFocus;}}
    internal CapsButton(bool main){primary=main;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;Font=Skin.Font(15,FontStyle.Bold);Cursor=Cursors.Hand;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);}
    void RefreshFocus(){Invalidate();if(Parent!=null){var r=Bounds;r.Inflate(8,8);Parent.Invalidate(r);}}
    protected override void OnMouseEnter(EventArgs e){hovered=true;Invalidate();base.OnMouseEnter(e);}
    protected override void OnMouseLeave(EventArgs e){hovered=false;Invalidate();base.OnMouseLeave(e);}
    protected override void OnMouseDown(MouseEventArgs e){mouseFocus=true;pressed=true;RefreshFocus();base.OnMouseDown(e);}
    protected override void OnMouseUp(MouseEventArgs e){pressed=false;Invalidate();base.OnMouseUp(e);}
    protected override void OnKeyDown(KeyEventArgs e){mouseFocus=false;if(e.KeyCode==Keys.Space)pressed=true;RefreshFocus();base.OnKeyDown(e);}
    protected override void OnKeyUp(KeyEventArgs e){pressed=false;RefreshFocus();base.OnKeyUp(e);}
    protected override void OnGotFocus(EventArgs e){mouseFocus=Control.MouseButtons!=MouseButtons.None;RefreshFocus();base.OnGotFocus(e);}
    protected override void OnLostFocus(EventArgs e){pressed=false;RefreshFocus();base.OnLostFocus(e);}
    protected override void OnPaint(PaintEventArgs e){
        e.Graphics.Clear(Parent.BackColor);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float s=Height/44f;
        Color fill=primary?(!Enabled?Skin.Line:pressed?Color.FromArgb(130,115,230):hovered?Color.FromArgb(169,156,255):Skin.Accent):pressed?Color.FromArgb(38,38,38):hovered&&Enabled?Skin.Line:Quiet?Skin.Ground:Color.FromArgb(47,47,47);
        using(var p=Skin.Round(new RectangleF(.5f*s,.5f*s,Width-s,Height-s),6*s)){using(var b=new SolidBrush(fill))e.Graphics.FillPath(b,p);if(!primary&&!Quiet)using(var pen=new Pen(Color.FromArgb(74,74,74),s))e.Graphics.DrawPath(pen,p);}
        var bounds=ClientRectangle;var flags=TextFormatFlags.NoPadding|TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix|TextFormatFlags.SingleLine;
        if(Image!=null){int size=(int)(18*s),gap=(int)(8*s),text=TextRenderer.MeasureText(e.Graphics,Text,Font,Size.Empty,flags).Width;int left=Quiet?0:(Width-size-gap-text)/2;
            e.Graphics.DrawImage(Image,new Rectangle(left,(Height-size)/2,size,size));bounds=new Rectangle(left+size+gap,0,text,Height);}
        TextRenderer.DrawText(e.Graphics,Text,Font,bounds,!Enabled?Skin.Muted:primary?Skin.OnAccent:Quiet&&!hovered?Skin.Muted:Skin.Text,flags);
    }
}
sealed class CapsProgress:Control {
    readonly Timer timer;readonly Stopwatch clock=Stopwatch.StartNew();double target,startValue,transitionStart;
    long lastAnnouncement;bool active;
    internal bool Failed,Indeterminate;
    internal bool Active{get{return active;}set{active=value;timer.Enabled=value;Invalidate();}}
    internal double RenderedValue{get{if(!Skin.Motion||!active)return target;double t=Math.Min(1,Math.Max(0,(clock.Elapsed.TotalSeconds-transitionStart)/.4));return startValue+(target-startValue)*(1-Math.Pow(1-t,3));}}
    internal double Value{get{return target;}set{double before=target;startValue=RenderedValue;transitionStart=clock.Elapsed.TotalSeconds;target=Math.Max(0,Math.Min(1,value));
        if(Math.Floor(before*100)!=Math.Floor(target*100)&&(Environment.TickCount-lastAnnouncement>=3000||target==1)){lastAnnouncement=Environment.TickCount;AccessibilityNotifyClients(AccessibleEvents.ValueChange,-1);}Invalidate();}}
    internal void Reset(){target=startValue=0;Invalidate();}
    protected override AccessibleObject CreateAccessibilityInstance(){return new ProgressAccessibility(this);}
    sealed class ProgressAccessibility:Control.ControlAccessibleObject {
        readonly CapsProgress owner;internal ProgressAccessibility(CapsProgress control):base(control){owner=control;}
        public override string Value{get{return owner.Indeterminate?"In progress":Math.Floor(owner.Value*100).ToString(CultureInfo.InvariantCulture)+"%";}set{}}
        public override AccessibleStates State{get{return base.State|AccessibleStates.ReadOnly;}}
    }
    internal CapsProgress(){TabStop=false;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);AccessibleName="Installation progress";AccessibleRole=AccessibleRole.ProgressBar;timer=new Timer{Interval=16};timer.Tick+=(s,e)=>{if(Skin.Motion)Invalidate();};}
    protected override void OnPaint(PaintEventArgs e){
        e.Graphics.Clear(Skin.Surface);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;float s=Height/38f,y=14*s,h=10*s,w=Indeterminate?Width:(float)(RenderedValue*Width);double seconds=clock.Elapsed.TotalSeconds;
        using(var track=Skin.Round(new RectangleF(0,y,Width,h),h/2)){
            using(var b=new SolidBrush(Failed?Color.FromArgb(112,60,65):Skin.Line))e.Graphics.FillPath(b,track);
            var state=e.Graphics.Save();e.Graphics.SetClip(track);using(var pen=new Pen(Color.FromArgb(110,0,0,0),2*s))e.Graphics.DrawLine(pen,0,y,Width,y);e.Graphics.Restore(state);
        }
        if(w<=0)return;
        Color accent=Failed?Skin.Error:Skin.Accent;
        // Soft glow stays outside the fill; each pass fades toward transparency.
        for(int i=7;i>=1;i--)using(var path=Skin.Round(new RectangleF(-i*s,y-i*s,w+2*i*s,h+2*i*s),h/2+i*s))using(var b=new SolidBrush(Color.FromArgb(3,accent)))e.Graphics.FillPath(b,path);
        using(var fill=Skin.Round(new RectangleF(0,y,Math.Max(.1f,w),h),Math.Min(h,w)/2)){
            using(var b=new LinearGradientBrush(new RectangleF(0,y,Math.Max(1,w),h),accent,Failed?accent:Color.FromArgb(195,185,255),0f))e.Graphics.FillPath(b,fill);
            if(active&&Skin.Motion){var state=e.Graphics.Save();e.Graphics.SetClip(fill);
                float t=(float)(seconds/1.6%1),ease=.5f-.5f*(float)Math.Cos(t*Math.PI),sheen=-80*s+(w+80*s)*ease;
                using(var b=new LinearGradientBrush(new RectangleF(sheen,y,80*s,h),Color.Transparent,Color.Transparent,0f)){
                    b.InterpolationColors=new ColorBlend{Colors=new[]{Color.FromArgb(0,255,255,255),Color.FromArgb(140,255,255,255),Color.FromArgb(0,255,255,255)},Positions=new[]{0f,.5f,1f}};
                    e.Graphics.FillRectangle(b,sheen,y,80*s,h);
                }e.Graphics.Restore(state);
            }
        }
        if(!Indeterminate&&!Failed){float opacity=active&&Skin.Motion?.775f+.225f*(float)Math.Cos(seconds*Math.PI*2/1.4):.55f;
            using(var path=new GraphicsPath()){path.AddEllipse(w-14*s,y-3*s,16*s,16*s);using(var b=new PathGradientBrush(path)){b.CenterPoint=new PointF(w-6*s,y+5*s);b.CenterColor=Color.FromArgb((int)(255*opacity),Color.White);b.SurroundColors=new[]{Color.FromArgb(0,255,255,255)};e.Graphics.FillPath(b,path);}}}
    }
    protected override void Dispose(bool disposing){if(disposing)timer.Dispose();base.Dispose(disposing);}
}
// Presentation-only moving average. No effect on the download worker or scheduling.
sealed class DownloadEstimate {
    struct Sample{internal double Time;internal long Bytes;internal Sample(double t,long b){Time=t;Bytes=b;}}
    readonly List<Sample> samples=new List<Sample>();
    internal double Speed{get;private set;}
    internal bool Stable{get;private set;}
    internal void Reset(){samples.Clear();Speed=0;Stable=false;}
    internal void Update(double now,long current){
        if(samples.Count>0&&(now<samples[samples.Count-1].Time||current<samples[samples.Count-1].Bytes))Reset();
        if(samples.Count>0&&now-samples[samples.Count-1].Time<.5)return;
        samples.Add(new Sample(now,current));while(samples.Count>2&&samples[1].Time<=now-10)samples.RemoveAt(0);
        double span=now-samples[0].Time;Speed=span>0?(current-samples[0].Bytes)/span:0;Stable=span>=3&&Speed>0;
    }
    internal string Remaining(long remaining){if(!Stable||remaining<=0)return "";double seconds=remaining/Speed;
        return seconds<60?"less than a minute left":"about "+Math.Ceiling(seconds/60).ToString(CultureInfo.InvariantCulture)+" min left";}
}
