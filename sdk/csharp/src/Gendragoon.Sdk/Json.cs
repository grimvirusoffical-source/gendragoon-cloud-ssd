using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Gendragoon.Sdk
{
    /// <summary>A small JSON reader and writer so the SDK has no dependencies (Unity ships none by default).
    /// Objects are Dictionary&lt;string, object?&gt; (keys kept in order), arrays List&lt;object?&gt;, numbers long or double.</summary>
    public static class Json
    {
        public static object? Parse(string s)
        {
            int i = 0;
            var v = Value(s, ref i);
            Ws(s, ref i);
            if (i != s.Length) throw new FormatException("gendragoon: trailing data after JSON");
            return v;
        }

        public static Dictionary<string, object?> Obj(string s) =>
            Parse(s) as Dictionary<string, object?> ?? throw new FormatException("gendragoon: expected a JSON object");

        static void Ws(string s, ref int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }

        static object? Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("gendragoon: unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                var d = new Dictionary<string, object?>(); i++; Ws(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return d; }
                while (true)
                {
                    Ws(s, ref i);
                    var k = Str(s, ref i); Ws(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("gendragoon: bad JSON object");
                    i++; d[k] = Value(s, ref i); Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return d; }
                    throw new FormatException("gendragoon: bad JSON object");
                }
            }
            if (c == '[')
            {
                var l = new List<object?>(); i++; Ws(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return l; }
                while (true)
                {
                    l.Add(Value(s, ref i)); Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return l; }
                    throw new FormatException("gendragoon: bad JSON array");
                }
            }
            if (c == '"') return Str(s, ref i);
            if (string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int st = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            var num = s.Substring(st, i - st);
            if (num.Length == 0) throw new FormatException("gendragoon: bad JSON value");
            if (long.TryParse(num, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n)) return n;
            return double.Parse(num, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static string Str(string s, ref int i)
        {
            if (s[i] != '"') throw new FormatException("gendragoon: expected a JSON string");
            i++;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                    default: throw new FormatException("gendragoon: bad JSON escape");
                }
            }
            throw new FormatException("gendragoon: unterminated JSON string");
        }

        public static string Write(object? v)
        {
            var sb = new StringBuilder();
            W(sb, v);
            return sb.ToString();
        }

        static void W(StringBuilder sb, object? v)
        {
            switch (v)
            {
                case null: sb.Append("null"); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case string s: Q(sb, s); break;
                case int n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); break;
                case long n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); break;
                case double d: sb.Append(d.ToString("R", CultureInfo.InvariantCulture)); break;
                case IDictionary<string, object?> d:
                    sb.Append('{'); var first = true;
                    foreach (var kv in d) { if (!first) sb.Append(','); first = false; Q(sb, kv.Key); sb.Append(':'); W(sb, kv.Value); }
                    sb.Append('}'); break;
                case System.Collections.IEnumerable l:
                    sb.Append('['); var f = true;
                    foreach (var x in l) { if (!f) sb.Append(','); f = false; W(sb, x); }
                    sb.Append(']'); break;
                default: throw new ArgumentException("gendragoon: cannot write " + v.GetType());
            }
        }

        static void Q(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        internal static string S(this Dictionary<string, object?> d, string k) => d.TryGetValue(k, out var v) && v is string s ? s : "";
        internal static long L(this Dictionary<string, object?> d, string k) => d.TryGetValue(k, out var v) ? v switch { long n => n, double x => (long)x, _ => 0 } : 0;
        internal static bool B(this Dictionary<string, object?> d, string k) => d.TryGetValue(k, out var v) && v is bool b && b;
        internal static Dictionary<string, object?> O(this Dictionary<string, object?> d, string k) => d.TryGetValue(k, out var v) && v is Dictionary<string, object?> o ? o : new Dictionary<string, object?>();
        internal static List<object?> A(this Dictionary<string, object?> d, string k) => d.TryGetValue(k, out var v) && v is List<object?> l ? l : new List<object?>();
    }
}
