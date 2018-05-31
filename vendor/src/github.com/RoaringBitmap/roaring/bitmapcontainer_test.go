package roaring

import (
	. "github.com/smartystreets/goconvey/convey"
	"math/rand"
	"testing"
)

func TestBitmapContainerNumberOfRuns024(t *testing.T) {

	Convey("bitmapContainer's numberOfRuns() function should be correct against the runContainer equivalent",
		t, func() {
			seed := int64(42)
			p("seed is %v", seed)
			rand.Seed(seed)

			trials := []trial{
				{n: 1000, percentFill: .1, ntrial: 10},
				/*
					trial{n: 100, percentFill: .5, ntrial: 10},
					trial{n: 100, percentFill: .01, ntrial: 10},
					trial{n: 100, percentFill: .99, ntrial: 10},
				*/
			}

			tester := func(tr trial) {
				for j := 0; j < tr.ntrial; j++ {
					p("TestBitmapContainerNumberOfRuns023 on check# j=%v", j)
					ma := make(map[int]bool)

					n := tr.n
					a := []uint16{}

					draw := int(float64(n) * tr.percentFill)
					for i := 0; i < draw; i++ {
						r0 := rand.Intn(n)
						a = append(a, uint16(r0))
						ma[r0] = true
					}

					showArray16(a, "a")

					// RunContainer compute this automatically
					rc := newRunContainer16FromVals(false, a...)
					rcNr := rc.numberOfRuns()

					p("rcNr from run container is %v", rcNr)

					// vs bitmapContainer
					bc := newBitmapContainer()
					for k := range ma {
						bc.iadd(uint16(k))
					}

					bcNr := bc.numberOfRuns()
					So(bcNr, ShouldEqual, rcNr)
					//fmt.Printf("\nnum runs was: %v\n", rcNr)
				}
				p("done with randomized bitmapContianer.numberOrRuns() checks for trial %#v", tr)
			}

			for i := range trials {
				tester(trials[i])
			}

		})
}

func TestBitmapcontainerAndCardinality(t *testing.T) {
	Convey("bitmap containers get cardinality in range, miss the last index, issue #183", t, func() {
		for r := 0; r <= 65535; r += 1 {
			c1 := newRunContainer16Range(0, uint16(r))
			c2 := newBitmapContainerwithRange(0, int(r))
			So(r+1, ShouldEqual, c1.andCardinality(c2))
		}
	})
}

func TestIssue181(t *testing.T) {

	Convey("Initial issue 181", t, func() {
		a := New()
		var x uint32

		// adding 1M integers
		for i := 1; i <= 1000000; i++ {
			x += uint32(rand.Intn(10) + 1)
			a.Add(x)
		}
		b := New()
		for i := 1; i <= int(x); i++ {
			b.Add(uint32(i))
		}
		So(b.AndCardinality(a), ShouldEqual, a.AndCardinality(b))
		So(b.AndCardinality(a), ShouldEqual, And(a, b).GetCardinality())
	})
	Convey("Second version of issue 181", t, func() {
		a := New()
		var x uint32

		// adding 1M integers
		for i := 1; i <= 1000000; i++ {
			x += uint32(rand.Intn(10) + 1)
			a.Add(x)
		}
		b := New()
		b.AddRange(1, uint64(x))

		So(b.AndCardinality(a), ShouldEqual, a.AndCardinality(b))
		So(b.AndCardinality(a), ShouldEqual, And(a, b).GetCardinality())

	})
}
